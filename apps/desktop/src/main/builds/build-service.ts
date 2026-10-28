import type { Build, InstallResult } from "@qa/shared";
import { randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { AppDatabase } from "../db/database";
import type { DeviceService } from "../devices/device-service";
import type { CommandRunner } from "../setup/command";
import { BuildFormatError, readApkMetadata, readIosAppMetadata } from "./metadata";
import { runToLog, type LoggedProcessRunner } from "../process/run-to-log";

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

export interface BuildServiceOptions {
  db: AppDatabase;
  run: CommandRunner;
  devices: Pick<DeviceService, "list">;
  /** 등록한 빌드를 복사해 두는 폴더 (userData/builds) */
  buildsDir: string;
  logDir: string;
  androidHome: string;
  home: string;
  /** 빌드 스크립트 실행기. 기본은 출력을 로그 파일로 흘려보내는 runToLog */
  runScript?: LoggedProcessRunner;
  /** 빌드 스크립트 제한 시간. 기본 45분 */
  scriptTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

interface BuildRow {
  id: string;
  app: string;
  target: "ios" | "android";
  app_id: string;
  version: string;
  build_number: string;
  commit_sha: string | null;
  source: Build["source"];
  path: string;
  created_at: string;
  label: string | null;
}

/** 오류 메시지에 붙일 로그 마지막 몇 줄. 화면에서 실패 이유를 바로 보게 한다. */
export function logTail(logFile: string, lines = 6, maxChars = 600): string {
  try {
    const tail = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
  } catch {
    return "";
  }
}

function toBuild(r: BuildRow): Build {
  return {
    id: r.id,
    app: r.app,
    target: r.target,
    appId: r.app_id,
    version: r.version,
    buildNumber: r.build_number,
    commit: r.commit_sha,
    source: r.source,
    path: r.path,
    createdAt: r.created_at,
    label: r.label,
  };
}

/**
 * 테스트 대상 앱 빌드를 등록·설치한다 (PLAN 3.2, T-105).
 * - 등록: 시뮬레이터용 .app 또는 .apk 를 앱 데이터 폴더에 복사하고 메타데이터를 읽어 DB 에 기록한다.
 * - 스크립트: 사용자가 고른 실행 파일을 셸 없이 실행하고, 스크립트가 QA_BUILD_INFO 파일에 적은 결과물을 등록한다.
 * - 설치: 부팅된 QA 기기에 설치하고 실제로 설치됐는지 확인한다.
 */
export class BuildService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly scriptRunner: LoggedProcessRunner;
  private scriptRunning = false;

  constructor(private readonly options: BuildServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.scriptRunner = options.runScript ?? runToLog;
  }

  list(): Build[] {
    const rows = this.options.db.db.prepare("SELECT * FROM build ORDER BY created_at DESC").all() as unknown as BuildRow[];
    return rows.map(toBuild);
  }

  get(id: string): Build {
    const row = this.options.db.db.prepare("SELECT * FROM build WHERE id = ?").get(id) as unknown as BuildRow | undefined;
    if (!row) throw new BuildError(`빌드를 찾지 못했다: ${id}`);
    return toBuild(row);
  }

  async registerPath(
    app: string,
    input: string,
    origin: { source: Build["source"]; commit: string | null; label?: string | null } = { source: "file", commit: null },
  ): Promise<Build> {
    // 폴더 경로 끝의 / 는 떼어 낸다(".app/" 도 .app 으로 본다).
    const path = input.length > 1 ? input.replace(/\/+$/, "") : input;
    if (!isAbsolute(path) || !existsSync(path)) throw new BuildError(`파일이 없다: ${input}`);
    const isApp = path.endsWith(".app") && statSync(path).isDirectory();
    const isApk = path.endsWith(".apk") && statSync(path).isFile();
    if (!isApp && !isApk) throw new BuildFormatError("시뮬레이터용 .app 폴더 또는 .apk 파일만 등록할 수 있다");

    const id = this.newId();
    const dir = join(this.options.buildsDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = join(dir, basename(path));
    try {
      if (isApp) {
        const copied = await this.options.run("/usr/bin/ditto", [path, dest], { timeoutMs: 300_000 });
        if (copied.code !== 0) throw new BuildError(`.app 복사 실패: ${copied.stderr.trim()}`);
      } else {
        copyFileSync(path, dest);
      }
      const meta = isApp
        ? await readIosAppMetadata(dest, this.options.run)
        : await readApkMetadata(dest, this.options.androidHome, this.options.run);
      const build: Build = {
        id,
        app,
        target: isApp ? "ios" : "android",
        appId: meta.appId,
        version: meta.version,
        buildNumber: meta.buildNumber,
        commit: origin.commit,
        source: origin.source,
        path: dest,
        createdAt: this.now().toISOString(),
        label: origin.label ?? null,
      };
      this.options.db.db
        .prepare(
          "INSERT INTO build (id, app, target, app_id, version, build_number, commit_sha, source, path, created_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(build.id, build.app, build.target, build.appId, build.version, build.buildNumber, build.commit, build.source, build.path, build.createdAt, build.label);
      return build;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * 스크립트 실행 환경. 앱의 환경 변수를 통째로 넘기지 않고 필요한 것만 고른다.
   * Finder 로 연 앱에는 사용자 PATH 가 없어 흔한 도구 경로(mise, Homebrew)를 명시적으로 더한다.
   */
  scriptEnv(infoFile: string, app: string): NodeJS.ProcessEnv {
    return this.toolEnv({ QA_BUILD_INFO: infoFile, QA_APP: app });
  }

  /** 빌드 도구(스크립트, tuist, pod, xcodebuild) 실행 환경. extra 를 더한다 */
  toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = this.options.home;
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      // CocoaPods 는 UTF-8 이 아니면 멈춘다
      LANG: process.env["LANG"] || "en_US.UTF-8",
      PATH: [`${home}/.local/share/mise/shims`, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      ...extra,
    };
    // git 원격 접근(SSH 에이전트)과 임시 폴더, 사용자 이름은 그대로 잇는다.
    for (const key of ["USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "DEVELOPER_DIR"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }

  /** 빌드는 한 번에 하나(스크립트·프로젝트 빌드 합쳐). 같은 빌드 폴더를 동시에 쓰면 결과가 섞인다 */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scriptRunning) throw new BuildError("이미 빌드가 진행 중이다. 끝난 뒤 다시 한다");
    this.scriptRunning = true;
    try {
      return await fn();
    } finally {
      this.scriptRunning = false;
    }
  }

  runScript(app: string, scriptPath: string): Promise<Build> {
    return this.exclusive(() => this.runScriptOnce(app, scriptPath));
  }

  private async runScriptOnce(app: string, scriptPath: string): Promise<Build> {
    if (!isAbsolute(scriptPath) || !existsSync(scriptPath) || !statSync(scriptPath).isFile()) throw new BuildError(`스크립트가 없다: ${scriptPath}`);
    try {
      accessSync(scriptPath, constants.X_OK);
    } catch {
      throw new BuildError(`실행 권한이 없다: ${scriptPath} (chmod +x 필요)`);
    }
    mkdirSync(this.options.logDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const infoFile = join(this.options.logDir, `build-${stamp}.info`);
    const logFile = join(this.options.logDir, `build-${stamp}.log`);
    writeFileSync(infoFile, "", { mode: 0o600 });
    const result = await this.scriptRunner(scriptPath, {
      env: this.scriptEnv(infoFile, app),
      cwd: dirname(scriptPath),
      logFile,
      timeoutMs: this.options.scriptTimeoutMs ?? 45 * 60_000,
    });
    if (result.timedOut) throw new BuildError(`빌드 스크립트가 시간 초과로 중단됐다. 로그: ${logFile}`);
    if (result.code !== 0) throw new BuildError(`빌드 스크립트 실패(코드 ${result.code}): ${logTail(logFile)} 로그: ${logFile}`);
    const info = Object.fromEntries(
      readFileSync(infoFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    ) as Record<string, string>;
    const artifact = info["ARTIFACT"];
    if (!artifact) throw new BuildError(`스크립트가 QA_BUILD_INFO 에 ARTIFACT=<경로> 를 적지 않았다. 로그: ${logFile}`);
    // 커밋은 git 해시 형식일 때만 기록한다.
    const commit = /^[0-9a-f]{7,64}$/i.test(info["COMMIT"] ?? "") ? (info["COMMIT"] ?? null) : null;
    return this.registerPath(app, artifact, { source: "script", commit });
  }

  async install(buildId: string, deviceId: string): Promise<InstallResult> {
    const build = this.get(buildId);
    const device = (await this.options.devices.list()).devices.find((d) => d.id === deviceId && d.platform === build.target);
    if (!device) throw new BuildError(`${build.target} 기기를 찾지 못했다: ${deviceId}`);
    if (device.state !== "booted") throw new BuildError(`기기가 실행 중이 아니다: ${device.name}. 기기 화면에서 먼저 준비한다`);

    if (build.target === "ios") {
      const r = await this.options.run("/usr/bin/xcrun", ["simctl", "install", device.id, build.path], { timeoutMs: 300_000 });
      if (r.code !== 0) throw new BuildError(`설치 실패: ${r.stderr.trim().slice(0, 300)}`);
      const check = await this.options.run("/usr/bin/xcrun", ["simctl", "get_app_container", device.id, build.appId, "app"]);
      return { buildId, deviceId, appId: build.appId, installed: check.code === 0 };
    }
    const adb = join(this.options.androidHome, "platform-tools", "adb");
    const serial = device.serial;
    if (!serial) throw new BuildError(`에뮬레이터 serial 을 알 수 없다: ${device.name}`);
    const r = await this.options.run(adb, ["-s", serial, "install", "-r", build.path], { timeoutMs: 300_000 });
    if (r.code !== 0 || /Failure/.test(r.stdout)) throw new BuildError(`설치 실패: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
    const check = await this.options.run(adb, ["-s", serial, "shell", "pm", "path", build.appId]);
    return { buildId, deviceId, appId: build.appId, installed: check.stdout.includes("package:") };
  }
}
