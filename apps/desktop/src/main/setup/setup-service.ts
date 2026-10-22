import type { InstallProgress, MaestroVerify, SetupReport, ToolId, ToolStatus } from "@qa/shared";
import type { CommandRunner } from "./command";
import { runEnvironmentChecks } from "./checks";
import type { ToolInstaller } from "./installer";

export interface SetupServiceOptions {
  installer: ToolInstaller;
  run: CommandRunner;
  env: { HOME: string; ANDROID_HOME?: string | undefined };
  now?: () => Date;
}

/** 설정 마법사의 main 쪽. 환경 점검, 도구 설치, Maestro 실행 확인을 맡는다. */
export class SetupService {
  constructor(private readonly options: SetupServiceOptions) {}

  async check(): Promise<SetupReport> {
    const tools: ToolStatus[] = [this.options.installer.status("jre"), this.options.installer.status("maestro")];
    const checks = await runEnvironmentChecks({ run: this.options.run, env: this.options.env, tools });
    return {
      checks,
      tools,
      ready: checks.filter((c) => c.required).every((c) => c.status === "ok"),
      checkedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  installTool(tool: ToolId): Promise<ToolStatus> {
    return this.options.installer.install(tool);
  }

  progress(): InstallProgress {
    return this.options.installer.progress();
  }

  /**
   * 앱이 설치한 JRE 와 Maestro 만으로 `maestro --version` 을 실행한다.
   * 사용자 PATH·JAVA_HOME·~/.maestro 에 기대지 않는다는 것을 확인하는 게 목적이다.
   */
  async verifyMaestro(): Promise<MaestroVerify> {
    const javaHome = this.options.installer.javaHome();
    const maestro = this.options.installer.maestroBin();
    if (!javaHome || !maestro) {
      return { ok: false, version: null, detail: "Java 런타임과 Maestro 를 먼저 설치해야 한다" };
    }
    const result = await this.options.run(maestro, ["--version"], {
      timeoutMs: 120_000,
      env: maestroEnv(javaHome, this.options.env.HOME),
    });
    const version = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    const expected = this.options.installer.status("maestro").version;
    if (result.code !== 0) {
      return { ok: false, version: null, detail: `실행 실패 (코드 ${result.code}): ${result.stderr.trim().slice(0, 300)}` };
    }
    return {
      ok: version === expected,
      version,
      detail: version === expected ? "앱이 설치한 Java 런타임으로 실행됨" : `버전이 다르다: 기대 ${expected}, 실제 ${version}`,
    };
  }
}

/** Maestro 실행 환경. 사용자 PATH 를 물려받지 않는다. */
export function maestroEnv(javaHome: string, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    JAVA_HOME: javaHome,
    PATH: `${javaHome}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    MAESTRO_CLI_NO_ANALYTICS: "true",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
    MAESTRO_DISABLE_UPDATE_CHECK: "true",
  };
}
