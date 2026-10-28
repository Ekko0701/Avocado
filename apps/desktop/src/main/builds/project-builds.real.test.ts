import type { ProjectLink } from "@qa/shared";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runToLog } from "../process/run-to-log";
import { runCommand } from "../setup/command";
import { readIosAppMetadata } from "./metadata";
import { ProjectBuilds } from "./project-builds";

// 실제 XcodeGen·xcodebuild 로 작은 iOS 앱을 만들어 연결·빌드·결과 찾기까지 돌린다(ADR 0025). 1~3분, 네트워크 없음.
//   QA_REAL_PROJECT_BUILD=1 pnpm --filter @qa/desktop exec vitest run src/main/builds/project-builds.real.test.ts
const enabled = process.env["QA_REAL_PROJECT_BUILD"] === "1";
const dir = mkdtempSync(join(tmpdir(), "qa-real-project-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROJECT_YML = `name: Probe
options:
  deploymentTarget:
    iOS: "17.0"
targets:
  Probe:
    type: application
    platform: iOS
    sources: [Sources]
    scheme: {}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.example.probe
        GENERATE_INFOPLIST_FILE: YES
        MARKETING_VERSION: "1.2.0"
        CURRENT_PROJECT_VERSION: "7"
`;
const APP_SWIFT = `import SwiftUI

@main
struct ProbeApp: App {
  var body: some Scene {
    WindowGroup { Text("Probe") }
  }
}
`;

describe.skipIf(!enabled)("프로젝트 폴더로 실제 빌드 (ADR 0025)", () => {
  it("XcodeGen 프로젝트를 연결하면 생성해 스킴을 읽고, 빌드하면 시뮬레이터용 .app 을 커밋과 함께 넘긴다", { timeout: 15 * 60_000 }, async () => {
    const root = join(dir, "Probe");
    mkdirSync(join(root, "Sources"), { recursive: true });
    writeFileSync(join(root, "project.yml"), PROJECT_YML);
    writeFileSync(join(root, "Sources", "ProbeApp.swift"), APP_SWIFT);
    writeFileSync(join(root, ".gitignore"), "*.xcodeproj\n");
    const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.email=qa@example.com", "-c", "user.name=qa", "commit", "-q", "-m", "probe");

    const links = new Map<string, ProjectLink>();
    const registered: { artifact: string; origin: { commit: string | null; label: string } }[] = [];
    const home = homedir();
    const builds = new ProjectBuilds({
      run: runCommand,
      runLogged: runToLog,
      // 앱의 BuildService.toolEnv 와 같은 변수(XcodeGen 은 USER 가 없으면 멈춘다)
      env: (extra) => ({
        HOME: home,
        LANG: "en_US.UTF-8",
        PATH: [`${home}/.local/share/mise/shims`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        ...Object.fromEntries(["USER", "LOGNAME", "TMPDIR"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
        ...extra,
      }),
      logDir: join(dir, "logs"),
      derivedDir: join(dir, "derived"),
      links: { get: (a) => links.get(a) ?? null, set: (a, l) => (l ? links.set(a, l) : links.delete(a)) },
      hints: () => ({ appId: "com.example.probe", scheme: "Probe", configuration: "Debug" }),
      register: async (app, artifact, origin) => {
        registered.push({ artifact, origin });
        return { id: "b", app, target: "ios", appId: "com.example.probe", version: "", buildNumber: "", commit: origin.commit, source: "project", path: artifact, createdAt: new Date().toISOString(), label: origin.label };
      },
      exclusive: (_info, fn) => fn({ signal: new AbortController().signal, step: () => undefined, log: () => undefined }),
    });

    const status = await builds.link("probe", root);
    expect(status.ios).toMatchObject({ tools: ["xcodegen"], container: join(root, "Probe.xcodeproj"), problem: null, teamScheme: "Probe" });
    expect(status.ios?.schemes).toContain("Probe");
    expect(status.ios?.configurations).toEqual(expect.arrayContaining(["Debug", "Release"]));
    expect(status.ios?.git).toEqual({ commit: git("rev-parse", "HEAD").trim(), changes: 0 });

    await builds.build("probe", "Probe", "Debug");
    const artifact = registered[0]?.artifact ?? "";
    expect(artifact).toBe(join(dir, "derived", "probe", "ios", "Build", "Products", "Debug-iphonesimulator", "Probe.app"));
    expect(registered[0]?.origin).toMatchObject({ commit: git("rev-parse", "HEAD").trim(), label: "Probe · Debug" });
    // 시뮬레이터용 빌드이고(실기기용이면 거부된다) 버전이 project.yml 그대로다
    expect(await readIosAppMetadata(artifact, runCommand)).toMatchObject({ appId: "com.example.probe", version: "1.2.0", buildNumber: "7" });
    expect(links.get("probe")).toMatchObject({ scheme: "Probe", configuration: "Debug" });
  });
});

// 이미 있는 프로젝트로 실제 빌드(선택). 그 폴더에서 Tuist·XcodeGen 생성과 pod install 을 할 수 있으니 복제본을 쓴다.
//   QA_REAL_PROJECT_DIR=<폴더> QA_REAL_PROJECT_SCHEME=<스킴> QA_REAL_PROJECT_CONFIGURATION=<구성> QA_REAL_PROJECT_APP_ID=<번들 ID> \
//   pnpm --filter @qa/desktop exec vitest run src/main/builds/project-builds.real.test.ts
const existing = {
  dir: process.env["QA_REAL_PROJECT_DIR"] ?? "",
  scheme: process.env["QA_REAL_PROJECT_SCHEME"] ?? "",
  configuration: process.env["QA_REAL_PROJECT_CONFIGURATION"] ?? "Debug",
  appId: process.env["QA_REAL_PROJECT_APP_ID"] ?? "",
};

describe.skipIf(!existing.dir || !existing.scheme || !existing.appId)("이미 있는 프로젝트로 실제 빌드", () => {
  it("연결해 스킴을 읽고, 고른 스킴·구성으로 빌드해 번들 ID 가 같은 시뮬레이터용 .app 을 찾는다", { timeout: 45 * 60_000 }, async () => {
    const links = new Map<string, ProjectLink>();
    const registered: string[] = [];
    const home = homedir();
    const builds = new ProjectBuilds({
      run: runCommand,
      runLogged: runToLog,
      env: (extra) => ({
        HOME: home,
        LANG: "en_US.UTF-8",
        PATH: [`${home}/.local/share/mise/shims`, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        ...Object.fromEntries(["USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
        ...extra,
      }),
      logDir: join(dir, "logs"),
      derivedDir: join(dir, "derived"),
      links: { get: (a) => links.get(a) ?? null, set: (a, l) => (l ? links.set(a, l) : links.delete(a)) },
      hints: () => ({ appId: existing.appId, scheme: existing.scheme, configuration: existing.configuration }),
      register: async (app, artifact, origin) => {
        registered.push(artifact);
        return { id: "b", app, target: "ios", appId: existing.appId, version: "", buildNumber: "", commit: origin.commit, source: "project", path: artifact, createdAt: new Date().toISOString(), label: origin.label };
      },
      exclusive: (_info, fn) => fn({ signal: new AbortController().signal, step: () => undefined, log: () => undefined }),
    });
    const status = await builds.link("existing", existing.dir);
    expect(status.ios?.problem ?? null).toBeNull();
    expect(status.ios?.schemes).toContain(existing.scheme);
    await builds.build("existing", existing.scheme, existing.configuration);
    expect(await readIosAppMetadata(registered[0] ?? "", runCommand)).toMatchObject({ appId: existing.appId });
  });
});
