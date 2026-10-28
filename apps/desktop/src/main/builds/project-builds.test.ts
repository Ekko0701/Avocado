import type { Build, ProjectLink } from "@qa/shared";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoggedProcessOptions, LoggedProcessResult } from "../process/run-to-log";
import type { CommandRunner } from "../setup/command";
import { BuildError } from "./build-service";
import { ProjectBuilds } from "./project-builds";

const SHA = "0123456789abcdef0123456789abcdef01234567";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-project-builds-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface FakeOptions {
  /** 프로젝트 폴더에 처음부터 있는 것(/ 로 끝나면 폴더) */
  entries: string[];
  /** 빌드가 결과 폴더에 만드는 .app 과 번들 ID */
  apps?: Record<string, string>;
  /** 이 명령이 실패한다(코드 65, 로그에 error: 줄) */
  fail?: string;
  /** 이 도구가 설치돼 있지 않다 */
  missing?: string;
  appId?: string | null;
  team?: { scheme: string | null; configuration: string | null };
  changes?: number;
  notGit?: boolean;
  /** 빌드 작업의 취소 신호(취소 시험) */
  signal?: AbortSignal;
}

/** 프로젝트 폴더·도구·xcodebuild 를 흉내 낸다. 실제 명령은 실행하지 않는다 */
function setup(opts: FakeOptions) {
  const root = join(dir, "Demo");
  mkdirSync(root, { recursive: true });
  for (const e of opts.entries) {
    if (e.endsWith("/")) mkdirSync(join(root, e), { recursive: true });
    else writeFileSync(join(root, e), "");
  }
  const logged: string[] = [];
  const quick: string[] = [];
  const bundleIds = new Map<string, string>();
  const run: CommandRunner = async (file, args) => {
    quick.push([file.split("/").pop(), ...args].join(" "));
    if (file.endsWith("xcodebuild") && args[0] === "-list") {
      const isWorkspace = args[2] === "-workspace";
      return { code: 0, stdout: JSON.stringify(isWorkspace ? { workspace: { schemes: ["Demo", "Pods-Demo"] } } : { project: { schemes: ["Demo"], configurations: ["Debug", "Release", "Staging"] } }), stderr: "" };
    }
    if (file.endsWith("git") && args.includes("rev-parse")) return opts.notGit ? { code: 128, stdout: "", stderr: "not a git repository" } : { code: 0, stdout: `${SHA}\n`, stderr: "" };
    if (file.endsWith("git") && args.includes("status")) return { code: 0, stdout: Array.from({ length: opts.changes ?? 0 }, (_, i) => ` M f${i}.swift`).join("\n"), stderr: "" };
    if (file.endsWith("plutil")) {
      const id = bundleIds.get(args.at(-1)?.replace(/\/Info\.plist$/, "") ?? "");
      return id ? { code: 0, stdout: `${id}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no plist" };
    }
    return { code: 1, stdout: "", stderr: `not mocked: ${file} ${args.join(" ")}` };
  };
  const runLogged = async (file: string, o: LoggedProcessOptions): Promise<LoggedProcessResult> => {
    const name = [file.split("/").pop(), ...(o.args ?? [])].join(" ");
    logged.push(name);
    if (o.signal?.aborted) return { code: -1, timedOut: false, canceled: true };
    if (opts.missing && file === opts.missing) {
      appendFileSync(o.logFile, `\n[qa] 실행 실패: spawn ${file} ENOENT\n`);
      return { code: -1, timedOut: false, canceled: false };
    }
    if (opts.fail && name.startsWith(opts.fail)) {
      appendFileSync(o.logFile, "Compiling App.swift\n/src/App.swift:3:5: error: cannot find 'foo' in scope\n** BUILD FAILED **\n");
      return { code: 65, timedOut: false, canceled: false };
    }
    if (name === "tuist generate --no-open" || name === "xcodegen generate") mkdirSync(join(root, "Demo.xcworkspace"), { recursive: true });
    if (name === "pod install") {
      mkdirSync(join(root, "Pods"), { recursive: true });
      writeFileSync(join(root, "Podfile.lock"), "PODS: []\n");
      writeFileSync(join(root, "Pods", "Manifest.lock"), "PODS: []\n");
    }
    if (file.endsWith("xcodebuild")) {
      const derived = o.args?.[(o.args.indexOf("-derivedDataPath") ?? 0) + 1] ?? "";
      const config = o.args?.[(o.args.indexOf("-configuration") ?? 0) + 1] ?? "";
      const products = join(derived, "Build", "Products", `${config}-iphonesimulator`);
      for (const [app, id] of Object.entries(opts.apps ?? { "Demo.app": "com.example.demo" })) {
        mkdirSync(join(products, app), { recursive: true });
        bundleIds.set(join(products, app), id);
      }
    }
    return { code: 0, timedOut: false, canceled: false };
  };
  const links = new Map<string, ProjectLink>();
  const registered: { app: string; artifact: string; origin: unknown }[] = [];
  const steps: string[] = [];
  const jobs: string[] = [];
  let running = false;
  const builds = new ProjectBuilds({
    run,
    runLogged,
    env: (extra) => ({ PATH: "/usr/bin", ...extra }),
    logDir: join(dir, "logs"),
    derivedDir: join(dir, "derived"),
    links: { get: (a) => links.get(a) ?? null, set: (a, l) => (l ? links.set(a, l) : links.delete(a)) },
    hints: () => ({ appId: opts.appId === undefined ? "com.example.demo" : opts.appId, scheme: opts.team?.scheme ?? null, configuration: opts.team?.configuration ?? null }),
    register: async (app, artifact, origin) => {
      registered.push({ app, artifact, origin });
      return { id: "b1", app, target: "ios", appId: "com.example.demo", version: "1.0", buildNumber: "1", commit: origin.commit, source: origin.source, path: artifact, createdAt: "2026-10-28T00:00:00.000Z", label: origin.label } satisfies Build;
    },
    exclusive: async (info, fn) => {
      if (running) throw new BuildError("이미 빌드가 진행 중이다");
      running = true;
      jobs.push(`${info.kind}:${info.label}`);
      try {
        return await fn({ signal: opts.signal ?? new AbortController().signal, step: (s) => steps.push(s), log: () => undefined });
      } finally {
        running = false;
      }
    },
  });
  return { root, builds, logged, quick, links, registered, steps, jobs };
}

describe("프로젝트 연결 (ADR 0025)", () => {
  it(".xcodeproj 폴더를 연결하면 스킴·구성·커밋을 읽고, 팀 기본값을 함께 준다", async () => {
    const f = setup({ entries: ["Demo.xcodeproj/"], changes: 2, team: { scheme: "Demo", configuration: "Staging" } });
    const status = await f.builds.link("demo", `${f.root}/`);
    expect(status.ios).toEqual({
      path: f.root,
      container: join(f.root, "Demo.xcodeproj"),
      tools: [],
      schemes: ["Demo"],
      configurations: ["Debug", "Release", "Staging"],
      git: { commit: SHA, changes: 2 },
      scheme: null,
      configuration: null,
      teamScheme: "Demo",
      teamConfiguration: "Staging",
      problem: null,
    });
    expect(f.links.get("demo")).toEqual({ path: f.root, scheme: null, configuration: null });
    expect(f.logged).toEqual([]);
  });

  it("Xcode 프로젝트가 아니면 연결하지 않는다", async () => {
    const f = setup({ entries: ["README.md"] });
    await expect(f.builds.link("demo", f.root)).rejects.toThrow(/Xcode 프로젝트 폴더가 아니다/);
    expect(f.links.size).toBe(0);
  });

  it("생성 전인 Tuist 프로젝트는 연결할 때 생성하고 워크스페이스의 스킴을 읽는다", async () => {
    const f = setup({ entries: ["Project.swift"] });
    const status = await f.builds.link("demo", f.root);
    expect(f.logged).toEqual(["tuist install", "tuist generate --no-open"]);
    expect(status.ios).toMatchObject({ container: join(f.root, "Demo.xcworkspace"), tools: ["tuist"], schemes: ["Demo", "Pods-Demo"], configurations: ["Debug", "Release"] });
  });

  it("연결을 해제하면 설정에서 지운다. 폴더가 사라졌으면 다시 연결하라고 알린다", async () => {
    const f = setup({ entries: ["Demo.xcodeproj/"] });
    await f.builds.link("demo", f.root);
    expect(f.builds.unlink("demo")).toEqual({ app: "demo", ios: null });
    expect(await f.builds.status("demo")).toEqual({ app: "demo", ios: null });
    f.links.set("demo", { path: join(dir, "gone"), scheme: null, configuration: null });
    expect((await f.builds.status("demo")).ios?.problem).toMatch(/프로젝트 폴더가 없다/);
  });
});

describe("프로젝트 빌드", () => {
  it("준비(Tuist 생성) → xcodebuild → 번들 ID 가 같은 .app 을 커밋·이름표와 함께 등록하고 고른 값을 기억한다", async () => {
    const f = setup({ entries: ["Project.swift"], apps: { "DemoWidget.app": "com.example.demo.widget", "Demo.app": "com.example.demo" }, changes: 3 });
    await f.builds.link("demo", f.root);
    f.logged.length = 0;
    const build = await f.builds.build("demo", "Demo", "Debug");
    const derived = join(dir, "derived", "demo", "ios");
    expect(f.logged).toEqual([
      "tuist install",
      "tuist generate --no-open",
      `xcodebuild -workspace ${join(f.root, "Demo.xcworkspace")} -scheme Demo -configuration Debug -destination generic/platform=iOS Simulator -derivedDataPath ${derived} -skipMacroValidation -skipPackagePluginValidation ARCHS=arm64 ONLY_ACTIVE_ARCH=NO build`,
    ]);
    expect(f.registered).toEqual([
      { app: "demo", artifact: join(derived, "Build", "Products", "Debug-iphonesimulator", "Demo.app"), origin: { source: "project", commit: SHA, label: "Demo · Debug · 커밋 안 한 변경 3개" } },
    ]);
    expect(build).toMatchObject({ source: "project", label: "Demo · Debug · 커밋 안 한 변경 3개" });
    expect(f.links.get("demo")).toEqual({ path: f.root, scheme: "Demo", configuration: "Debug" });
    // 빌드 화면에 보이는 작업 이름과 단계
    expect(f.jobs).toEqual(["prepare:프로젝트 준비", "project:Demo · Debug"]);
    expect(f.steps.slice(-4)).toEqual(["tuist install", "tuist generate", "xcodebuild", "결과 등록"]);
  });

  it("취소하면 그 단계에서 멈추고 등록하지 않는다", async () => {
    const controller = new AbortController();
    const f = setup({ entries: ["Demo.xcodeproj/"], signal: controller.signal });
    await f.builds.link("demo", f.root);
    controller.abort();
    await expect(f.builds.build("demo", "Demo", "Debug")).rejects.toThrow("xcodebuild 중에 빌드를 취소했다");
    expect(f.registered).toEqual([]);
  });

  it("Pods 가 최신이 아닐 때만 pod install 을 한다", async () => {
    const f = setup({ entries: ["Demo.xcodeproj/", "Demo.xcworkspace/", "Podfile"] });
    await f.builds.link("demo", f.root);
    f.logged.length = 0;
    await f.builds.build("demo", "Demo", "Debug");
    expect(f.logged.filter((l) => l === "pod install")).toHaveLength(1);
    f.logged.length = 0;
    await f.builds.build("demo", "Demo", "Debug");
    expect(f.logged.some((l) => l === "pod install")).toBe(false);
  });

  it("xcodebuild 가 실패하면 error: 줄과 로그 경로를 알리고 등록하지 않는다", async () => {
    const f = setup({ entries: ["Demo.xcodeproj/"], fail: "xcodebuild" });
    await f.builds.link("demo", f.root);
    const error = await f.builds.build("demo", "Demo", "Debug").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuildError);
    expect((error as Error).message).toMatch(/^xcodebuild 실패\(코드 65\)/);
    expect((error as Error).message).toContain("error: cannot find 'foo' in scope");
    expect((error as Error).message).toMatch(/로그: .*project-build-demo-.*\.log/);
    expect(f.registered).toEqual([]);
  });

  it("도구가 없으면 설치하라고 알린다", async () => {
    const f = setup({ entries: ["project.yml"], missing: "xcodegen" });
    await expect(f.builds.link("demo", f.root)).rejects.toThrow(/xcodegen 를 찾지 못했다/);
  });

  it("앱 ID 와 같은 .app 이 없거나, 앱 ID 가 없는데 .app 이 여럿이면 등록하지 않는다", async () => {
    const other = setup({ entries: ["Demo.xcodeproj/"], apps: { "Other.app": "com.example.other" } });
    await other.builds.link("demo", other.root);
    await expect(other.builds.build("demo", "Demo", "Debug")).rejects.toThrow(/번들 ID 가 com\.example\.demo 인 \.app 이 없다\(찾은 것: Other\.app\(com\.example\.other\)\)/);
    rmSync(join(dir, "Demo"), { recursive: true, force: true });
    rmSync(join(dir, "derived"), { recursive: true, force: true });
    const many = setup({ entries: ["Demo.xcodeproj/"], appId: null, apps: { "A.app": "a", "B.app": "b" } });
    await many.builds.link("demo", many.root);
    await expect(many.builds.build("demo", "Demo", "Debug")).rejects.toThrow(/\.app 이 여러 개다/);
    expect([...other.registered, ...many.registered]).toEqual([]);
  });

  it("git 저장소가 아니면 커밋 없이 등록하고, 연결 전에는 빌드하지 않는다", async () => {
    const f = setup({ entries: ["Demo.xcodeproj/"], notGit: true });
    await expect(f.builds.build("demo", "Demo", "Debug")).rejects.toThrow(/프로젝트를 먼저 연결한다/);
    await f.builds.link("demo", f.root);
    await f.builds.build("demo", "Demo", "Release");
    expect(f.registered[0]?.origin).toEqual({ source: "project", commit: null, label: "Demo · Release" });
    expect(existsSync(join(dir, "logs"))).toBe(true);
  });
});
