import type { Build, IosProject, ProjectLink, ProjectStatus } from "@qa/shared";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LoggedProcessRunner } from "../process/run-to-log";
import type { CommandRunner } from "../setup/command";
import { BuildError, logTail, type BuildJob, type BuildJobInfo } from "./build-service";
import { builtApps, countChanges, looksLikeXcodeProject, parseXcodebuildList, podsOutdated, xcodeLayout, type XcodeLayout } from "./xcode-project";

export interface ProjectBuildsOptions {
  /** 짧은 명령(xcodebuild -list, git, plutil) */
  run: CommandRunner;
  /** 오래 걸리는 단계(tuist, xcodegen, pod, xcodebuild build). 출력은 로그 파일로 */
  runLogged: LoggedProcessRunner;
  /** 빌드 스크립트와 같은 실행 환경(ADR 0008). extra 를 더한다 */
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  logDir: string;
  /** 앱별 빌드 결과(DerivedData)를 남겨 두는 폴더(userData/derived) */
  derivedDir: string;
  /** 이 Mac 의 프로젝트 연결(settings.json projects) */
  links: { get(app: string): ProjectLink | null; set(app: string, link: ProjectLink | null): void };
  /** 워크스페이스 app.yaml 의 iOS 앱 ID 와 팀 스킴·구성 */
  hints: (app: string) => { appId: string | null; scheme: string | null; configuration: string | null };
  register: (app: string, artifact: string, origin: { source: "project"; commit: string | null; label: string }) => Promise<Build>;
  /** 빌드 스크립트와 합쳐 한 번에 하나만. 단계·로그를 알리고 취소 신호를 받는다(BuildService.exclusive) */
  exclusive: <T>(info: BuildJobInfo, fn: (job: BuildJob) => Promise<T>) => Promise<T>;
  now?: () => Date;
  /** 단계마다 제한 시간. 기본 45분(ADR 0008) */
  stepTimeoutMs?: number;
}

/**
 * 연결한 프로젝트 폴더를 시뮬레이터용으로 빌드해 등록한다 (ADR 0025, iOS).
 * 고른 폴더에서 그대로 빌드하고(Xcode 와 같다), Tuist·XcodeGen·CocoaPods 준비 단계를 자동으로 돌린다.
 */
export class ProjectBuilds {
  constructor(private readonly options: ProjectBuildsOptions) {}

  async status(app: string, opts: { prepare?: boolean } = {}): Promise<ProjectStatus> {
    const link = this.options.links.get(app);
    if (!link) return { app, ios: null };
    if (opts.prepare && existsSync(link.path)) await this.options.exclusive({ app, kind: "prepare", label: "프로젝트 준비" }, (job) => this.prepare(app, link.path, { always: false }, job));
    return { app, ios: await this.describe(app, link) };
  }

  /** 고른 경로를 이 앱의 iOS 프로젝트로 연결한다. 생성 전인 Tuist·XcodeGen 프로젝트면 바로 만들어 스킴을 읽는다 */
  async link(app: string, selected: string): Promise<ProjectStatus> {
    const path = selected.length > 1 ? selected.replace(/\/+$/, "") : selected;
    if (!isAbsolute(path) || !existsSync(path)) throw new BuildError(`폴더가 없다: ${selected}`);
    const layout = xcodeLayout(path);
    if (!looksLikeXcodeProject(layout)) throw new BuildError("Xcode 프로젝트 폴더가 아니다(.xcworkspace·.xcodeproj·Project.swift·project.yml 이 없다)");
    const previous = this.options.links.get(app);
    const same = previous?.path === path;
    this.options.links.set(app, { path, scheme: same ? previous.scheme : null, configuration: same ? previous.configuration : null });
    if (!layout.container) await this.options.exclusive({ app, kind: "prepare", label: "프로젝트 준비" }, (job) => this.prepare(app, path, { always: false }, job));
    return this.status(app);
  }

  unlink(app: string): ProjectStatus {
    this.options.links.set(app, null);
    return { app, ios: null };
  }

  build(app: string, scheme: string, configuration: string): Promise<Build> {
    return this.options.exclusive({ app, kind: "project", label: `${scheme} · ${configuration}` }, async (job) => {
      const link = this.options.links.get(app);
      if (!link) throw new BuildError("프로젝트를 먼저 연결한다");
      if (!existsSync(link.path)) throw new BuildError(`프로젝트 폴더가 없다: ${link.path}`);
      // 생성 파일(Project.swift·project.yml)이 바뀌었을 수 있어 빌드할 때마다 다시 만든다
      const logFile = await this.prepare(app, link.path, { always: true }, job);
      const layout = xcodeLayout(link.path);
      if (!layout.container) throw new BuildError(`.xcworkspace·.xcodeproj 를 찾지 못했다. 로그: ${logFile}`);
      const derived = join(this.options.derivedDir, app, "ios");
      await this.step(
        "/usr/bin/xcodebuild",
        [
          layout.container.kind === "workspace" ? "-workspace" : "-project",
          layout.container.path,
          "-scheme",
          scheme,
          "-configuration",
          configuration,
          "-destination",
          "generic/platform=iOS Simulator",
          "-derivedDataPath",
          derived,
          // 명령줄 빌드에는 매크로·패키지 플러그인 승인 창이 없다(사용자가 고른 자기 프로젝트, ADR 0025)
          "-skipMacroValidation",
          "-skipPackagePluginValidation",
          // Avocado 는 Apple Silicon 만 지원한다. 시뮬레이터용 x86_64 까지 만들면 빌드 시간이 두 배다
          "ARCHS=arm64",
          "ONLY_ACTIVE_ARCH=NO",
          "build",
        ],
        layout,
        logFile,
        job,
      );
      job.step("결과 등록");
      const artifact = await this.findApp(app, join(derived, "Build", "Products", `${configuration}-iphonesimulator`), logFile);
      const git = await this.git(layout.root);
      this.options.links.set(app, { ...link, scheme, configuration });
      const label = `${scheme} · ${configuration}${git && git.changes > 0 ? ` · 커밋 안 한 변경 ${git.changes}개` : ""}`;
      return this.options.register(app, artifact, { source: "project", commit: git?.commit ?? null, label });
    });
  }

  private logFile(app: string): string {
    mkdirSync(this.options.logDir, { recursive: true });
    const stamp = (this.options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
    return join(this.options.logDir, `project-build-${app}-${stamp}.log`);
  }

  /** Tuist·XcodeGen 생성(always 가 아니면 컨테이너가 없을 때만)과 필요할 때 pod install. 로그 파일을 돌려준다 */
  private async prepare(app: string, path: string, opts: { always: boolean }, job: BuildJob): Promise<string> {
    const layout = xcodeLayout(path);
    const logFile = this.logFile(app);
    job.log(logFile);
    const generate = opts.always || !layout.container;
    if (generate && layout.tools.includes("tuist")) {
      await this.step("tuist", ["install"], layout, logFile, job);
      await this.step("tuist", ["generate", "--no-open"], layout, logFile, job);
    }
    if (generate && layout.tools.includes("xcodegen")) await this.step("xcodegen", ["generate"], layout, logFile, job);
    if (podsOutdated(layout.root)) await this.step("pod", ["install"], layout, logFile, job);
    return logFile;
  }

  private async step(file: string, args: string[], layout: XcodeLayout, logFile: string, job: BuildJob): Promise<void> {
    // 단계 이름: 도구와 하위 명령(옵션은 빼고). 예: tuist generate, xcodebuild
    const name = [file.split("/").pop() ?? file, ...(args[0] && !args[0].startsWith("-") ? [args[0]] : [])].join(" ");
    job.step(name);
    appendFileSync(logFile, `\n== ${name} ==\n`, { mode: 0o600 });
    const result = await this.options.runLogged(file, {
      args,
      cwd: layout.root,
      // mise 를 쓰는 프로젝트: 빌드하는 동안만 이 폴더의 설정을 믿는다(ADR 0008 발견)
      env: this.options.env({ MISE_TRUSTED_CONFIG_PATHS: layout.root }),
      logFile,
      timeoutMs: this.options.stepTimeoutMs ?? 45 * 60_000,
      signal: job.signal,
    });
    if (result.canceled) throw new BuildError(`${name} 중에 빌드를 취소했다`);
    if (result.timedOut) throw new BuildError(`${name} 이 시간 초과로 중단됐다. 로그: ${logFile}`);
    if (result.code === 0) return;
    const tail = logTail(logFile);
    if (/ENOENT/.test(tail)) throw new BuildError(`${file} 를 찾지 못했다. 설치하거나 mise·Homebrew 경로에 둔다. 로그: ${logFile}`);
    throw new BuildError(`${name} 실패(코드 ${result.code}): ${errorLines(logFile) || tail} 로그: ${logFile}`);
  }

  /** 빌드 결과 중 앱 설정의 iOS 앱 ID 와 번들 ID 가 같은 .app. 앱 ID 가 없으면 하나뿐일 때만 */
  private async findApp(app: string, productsDir: string, logFile: string): Promise<string> {
    const apps = builtApps(productsDir);
    if (apps.length === 0) throw new BuildError(`빌드는 끝났지만 ${productsDir} 에 .app 이 없다. 스킴이 앱을 빌드하는지 확인한다. 로그: ${logFile}`);
    const { appId } = this.options.hints(app);
    if (!appId) {
      if (apps.length === 1 && apps[0]) return apps[0];
      throw new BuildError(`.app 이 여러 개다(${apps.map((a) => a.split("/").pop()).join(", ")}). 워크스페이스의 앱 설정에 iOS 앱 ID 를 적는다`);
    }
    const found: string[] = [];
    for (const path of apps) {
      const r = await this.options.run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Info.plist")]);
      const id = r.code === 0 ? r.stdout.trim() : "?";
      if (id === appId) return path;
      found.push(`${path.split("/").pop() ?? path}(${id})`);
    }
    throw new BuildError(`번들 ID 가 ${appId} 인 .app 이 없다(찾은 것: ${found.join(", ")}). 스킴이나 앱 설정의 iOS 앱 ID 를 확인한다`);
  }

  private async describe(app: string, link: ProjectLink): Promise<IosProject> {
    const hints = this.options.hints(app);
    const base: IosProject = {
      path: link.path,
      container: null,
      tools: [],
      schemes: [],
      configurations: [],
      git: null,
      scheme: link.scheme,
      configuration: link.configuration,
      teamScheme: hints.scheme,
      teamConfiguration: hints.configuration,
      problem: null,
    };
    if (!existsSync(link.path)) return { ...base, problem: `프로젝트 폴더가 없다: ${link.path}. 다시 연결한다` };
    const layout = xcodeLayout(link.path);
    const git = await this.git(layout.root);
    if (!layout.container) {
      const generated = layout.tools.includes("tuist") || layout.tools.includes("xcodegen");
      return {
        ...base,
        tools: layout.tools,
        git,
        problem: generated ? "프로젝트를 아직 생성하지 않았다. 스킴 다시 읽기를 누르면 생성한 뒤 읽는다" : ".xcworkspace·.xcodeproj 를 찾지 못했다",
      };
    }
    try {
      const { schemes, configurations } = await this.list(layout);
      return {
        ...base,
        container: layout.container.path,
        tools: layout.tools,
        git,
        schemes,
        configurations,
        problem: schemes.length === 0 ? "공유된 스킴이 없다. Xcode 의 Product → Scheme → Manage Schemes 에서 Shared 를 켠다" : null,
      };
    } catch (error) {
      return { ...base, container: layout.container.path, tools: layout.tools, git, problem: error instanceof Error ? error.message : String(error) };
    }
  }

  private async list(layout: XcodeLayout): Promise<{ schemes: string[]; configurations: string[] }> {
    if (!layout.container) return { schemes: [], configurations: [] };
    const listOf = async (flag: "-workspace" | "-project", path: string) => {
      const r = await this.options.run("/usr/bin/xcodebuild", ["-list", "-json", flag, path], { cwd: layout.root, env: this.options.env(), timeoutMs: 180_000 });
      if (r.code !== 0) throw new BuildError(`스킴을 읽지 못했다: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return parseXcodebuildList(r.stdout);
    };
    const listed = await listOf(layout.container.kind === "workspace" ? "-workspace" : "-project", layout.container.path);
    let configurations = listed.configurations;
    if (configurations.length === 0) {
      // 워크스페이스는 구성을 알려 주지 않는다. 루트의 .xcodeproj 에서 읽는다
      const projects = readdirSync(layout.root).filter((name) => name.endsWith(".xcodeproj") && name !== "Pods.xcodeproj").slice(0, 3);
      for (const project of projects) {
        const more = await listOf("-project", join(layout.root, project)).catch(() => null);
        if (more) configurations = [...new Set([...configurations, ...more.configurations])];
      }
    }
    return { schemes: listed.schemes, configurations: configurations.length > 0 ? configurations : ["Debug", "Release"] };
  }

  /** HEAD 커밋과 커밋하지 않은 변경 수. git 저장소가 아니면 null */
  private async git(root: string): Promise<{ commit: string; changes: number } | null> {
    const head = await this.options.run("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
    const commit = head.stdout.trim();
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return null;
    const status = await this.options.run("/usr/bin/git", ["-C", root, "status", "--porcelain"], { timeoutMs: 120_000 });
    return { commit, changes: status.code === 0 ? countChanges(status.stdout) : 0 };
  }
}

/** xcodebuild 로그의 마지막 error: 줄 몇 개(실패 이유를 화면에 바로 보이게) */
function errorLines(logFile: string, max = 5): string {
  const tail = logTail(logFile, 400, 20_000);
  const errors = tail.split("\n").filter((line) => /\berror\b:/i.test(line));
  return errors.slice(-max).join("\n").slice(-800);
}
