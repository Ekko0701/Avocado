import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LoggedProcessResult, LoggedProcessRunner } from "../process/run-to-log";
import type { CommandRunner } from "../setup/command";
import { runnerBundleId } from "./ios-device";

/**
 * agent-device(iOS 실기기 재생 엔진, ADR 0034) 실행 도우미.
 * - 앱이 설치한 고정 버전만 쓰고 Electron 의 Node 로 돌린다(ELECTRON_RUN_AS_NODE). 사용자의 npm·PATH 에 기대지 않는다.
 * - 상태·설정·러너 빌드 폴더는 앱 데이터(<root>) 안에 둔다. 업데이트 확인은 끈다.
 * - 데몬은 처음 뜰 때의 환경 변수를 계속 쓰므로, 명령을 마치면 이 상태 폴더의 데몬을 내린다.
 * - 러너 빌드 폴더는 팀마다 따로 둔다. 설정이 바뀐 폴더는 agent-device 가 스스로 비우지 않는다(PoC 문제 3).
 */
export interface AgentDeviceOptions {
  /** 설치된 bin/agent-device.mjs. 없으면 null */
  entry: () => string | null;
  /** Electron 실행 파일(process.execPath) */
  nodeBin: string;
  /** userData/agent-device */
  root: string;
  home: string;
  run: CommandRunner;
  runToLog: LoggedProcessRunner;
}

export class AgentDeviceError extends Error {
  constructor(
    message: string,
    /** agent-device 가 준 원인(details.reason). 예: signing_no_development_team */
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "AgentDeviceError";
  }
}

/** agent-device --json 실패 응답에서 쓰는 칸 */
const JsonFailureSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    details: z.object({ reason: z.string().optional() }).passthrough().optional(),
  }),
});

/** iOS 가 UI 자동화를 켜지 못했다(러너가 뜨는 동안 잠겼거나 iPhone 의 허용 요청에 답하지 않음) */
const AUTOMATION_TIMEOUT = /Timed out while enabling automation mode/i;
/** 러너의 프로비저닝 프로파일에 기기가 없어 설치가 거부됐다 */
const PROFILE_REJECTED = /cannot be installed on this device|0xe8008012/i;

/** 러너 시작 실패 원인 → 사람이 할 일(agent-device help physical-device 의 details.reason) */
export function runnerFailureHint(reason: string | null, message: string): string {
  switch (reason) {
    case "devtools_security_developer_mode_disabled":
      return "Mac 의 개발 도구 보안 설정이 꺼져 있다. 터미널에서 sudo DevToolsSecurity -enable 을 실행한다";
    case "device_developer_mode_disabled":
      return "iPhone 의 개발자 모드가 꺼져 있다. 설정 → 개인정보 보호 및 보안 → 개발자 모드를 켜고 재시동한다";
    case "signing_no_development_team":
    case "signing_unspecified":
    case "signing_provisioning_profile_missing":
      return "러너를 서명하지 못했다. Xcode → 설정 → 계정에 고른 팀의 Apple 계정이 로그인돼 있는지 확인한다";
    case "bundle_identifier_already_registered":
      return "러너 번들 ID 가 다른 팀에 등록돼 있다. 설정에서 다른 서명 팀을 고른다";
    case "device_developer_disk_image_unavailable":
      return "iPhone 의 개발자 디스크 이미지를 준비하지 못했다. iPhone 잠금을 풀고 케이블을 다시 연결한 뒤 Xcode 의 기기 창에서 준비가 끝났는지 본다";
    default:
      if (AUTOMATION_TIMEOUT.test(message)) {
        return "iPhone 이 UI 자동화를 켜지 못했다. 잠금을 풀어 둔 채로 다시 준비하고, iPhone 에 허용 요청이나 암호 입력이 뜨면 답한다";
      }
      if (PROFILE_REJECTED.test(message)) {
        return "러너의 프로비저닝 프로파일에 이 iPhone 이 없다. 한 번 더 준비하면 프로파일을 새로 받는다";
      }
      return message;
  }
}

export class AgentDevice {
  constructor(private readonly options: AgentDeviceOptions) {}

  entry(): string {
    const entry = this.options.entry();
    if (!entry) throw new AgentDeviceError("iOS 실기기 도구(agent-device)가 설치되지 않았다. 기기 화면에서 iPhone 을 준비한다");
    return entry;
  }

  stateDir(): string {
    return join(this.options.root, "state");
  }

  derivedDir(teamId: string): string {
    return join(this.options.root, `derived-${teamId}`);
  }

  env(teamId: string): NodeJS.ProcessEnv {
    return {
      HOME: this.options.home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      ELECTRON_RUN_AS_NODE: "1",
      AGENT_DEVICE_HOME: join(this.options.root, "home"),
      AGENT_DEVICE_STATE_DIR: this.stateDir(),
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: this.derivedDir(teamId),
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      AGENT_DEVICE_IOS_TEAM_ID: teamId,
      AGENT_DEVICE_IOS_BUNDLE_ID: runnerBundleId(teamId),
    };
  }

  /** CLI 인자 앞부분: Electron 을 Node 로 써서 진입점을 돌린다 */
  private argv(args: readonly string[]): string[] {
    return [this.entry(), ...args];
  }

  /** 러너를 서명·빌드해 iPhone 에 올리고 응답을 확인한다(처음 한 번 몇 분). 실패하면 원인과 할 일을 담아 던진다 */
  async prepareRunner(udid: string, teamId: string, timeoutMs = 15 * 60_000): Promise<void> {
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
    try {
      let failure = await this.prepareOnce(udid, teamId, timeoutMs);
      if (failure && (PROFILE_REJECTED.test(failure.message) || this.runnerLogsMention(PROFILE_REJECTED))) {
        // 로컬의 오래된 팀 프로파일로 서명돼 설치가 거부됐다. 빌드 중 Xcode 가 프로파일을 새로 받으므로 앱의 빌드 폴더를 비우고 한 번 더 한다(PoC 문제 4)
        await this.stopDaemon(teamId);
        rmSync(this.derivedDir(teamId), { recursive: true, force: true });
        failure = await this.prepareOnce(udid, teamId, timeoutMs);
      }
      if (failure) {
        const message = this.runnerLogsMention(AUTOMATION_TIMEOUT)
          ? `${failure.message} (Timed out while enabling automation mode)`
          : this.runnerLogsMention(PROFILE_REJECTED)
            ? `${failure.message} (0xe8008012)`
            : failure.message;
        throw new AgentDeviceError(runnerFailureHint(failure.reason, message), failure.reason);
      }
    } finally {
      await this.stopDaemon(teamId);
    }
  }

  private async prepareOnce(udid: string, teamId: string, timeoutMs: number): Promise<{ message: string; reason: string | null } | null> {
    const r = await this.options.run(
      this.options.nodeBin,
      this.argv(["prepare", "ios-runner", "--platform", "ios", "--udid", udid, "--timeout", String(timeoutMs), "--json"]),
      { env: this.env(teamId), timeoutMs: timeoutMs + 60_000, cwd: this.options.root },
    );
    if (r.code === 0) return null;
    return parseJsonFailure(r.stdout) ?? { message: (r.stderr || r.stdout).trim().slice(-600) || `agent-device 종료 코드 ${r.code}`, reason: null };
  }

  /**
   * 플로우를 Maestro 호환 모드로 재생한다. 산출물은 artifactsDir 에, 콘솔 출력은 logFile 에 남는다.
   * -e 값은 인자로 넘긴다(agent-device 는 inputText 값을 산출물에 쓰지 않는다. 선택자에 넣은 값은 실패 메시지에 남아 가림 대상이다)
   */
  async test(input: {
    udid: string;
    teamId: string;
    flowPath: string;
    env: Record<string, string>;
    artifactsDir: string;
    logFile: string;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<LoggedProcessResult> {
    const vars = Object.entries(input.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    try {
      return await this.options.runToLog(this.options.nodeBin, {
        args: this.argv([
          "test",
          input.flowPath,
          "--maestro",
          "--platform",
          "ios",
          "--udid",
          input.udid,
          "--artifacts-dir",
          input.artifactsDir,
          "--timeout",
          String(input.timeoutMs),
          ...vars,
        ]),
        env: this.env(input.teamId),
        cwd: input.cwd,
        logFile: input.logFile,
        timeoutMs: input.timeoutMs + 60_000,
        signal: input.signal,
      });
    } finally {
      await this.stopDaemon(input.teamId);
    }
  }

  /** 이 상태 폴더의 러너 로그(sessions/<세션>/runner.log)에 이 문구가 있는지. 최근 한 시간 안에 쓴 로그만 본다 */
  runnerLogsMention(pattern: RegExp, now = Date.now()): boolean {
    const sessions = join(this.stateDir(), "sessions");
    if (!existsSync(sessions)) return false;
    for (const name of readdirSync(sessions)) {
      const log = join(sessions, name, "runner.log");
      if (!existsSync(log) || now - statSync(log).mtimeMs > 3_600_000) continue;
      if (pattern.test(readFileSync(log, "utf8"))) return true;
    }
    return false;
  }

  /** 이 상태 폴더의 데몬과 남은 러너를 내린다. 데몬이 없으면 아무것도 하지 않는다 */
  async stopDaemon(teamId: string): Promise<void> {
    if (!existsSync(join(this.stateDir(), "daemon.json"))) return;
    await this.options.run(this.options.nodeBin, this.argv(["daemon", "stop", "--clean", "--state-dir", this.stateDir()]), {
      env: this.env(teamId),
      timeoutMs: 90_000,
      cwd: this.options.root,
    });
  }
}

/** --json 출력의 실패 응답. 형식이 다르면 null */
export function parseJsonFailure(stdout: string): { message: string; reason: string | null } | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JsonFailureSchema.safeParse(JSON.parse(stdout.slice(start)));
    if (!parsed.success) return null;
    return { message: parsed.data.error.message, reason: parsed.data.error.details?.reason ?? null };
  } catch {
    return null;
  }
}
