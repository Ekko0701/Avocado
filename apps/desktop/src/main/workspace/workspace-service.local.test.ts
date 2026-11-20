import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AskpassServer, RemoteProvider } from "@qa/remote";
import { SetWorkspaceSourceInputSchema, type RunSummary, type WorkspaceSourceKind } from "@qa/shared";
import { testcaseTemplate } from "@qa/workspace";
import { RunQueue, type QueuedRun } from "../runs/run-queue";
import { createWorkspaceRunHandlers } from "../runs/workspace-run-handlers";
import { createWorkspaceHandlers } from "./workspace-handlers";
import { displayPath, WorkspaceError, WorkspaceService } from "./workspace-service";

// 로컬 워크스페이스(ADR 0036): 원격 없이 이 Mac 의 git 저장소 하나에 main 으로 바로 저장한다.
const AUTHOR = "tester";
const LOCAL_REFUSAL = /로컬 워크스페이스에서는 쓸 수 없다\. 설정에서 GitHub 사용을 켠다/;
let dir: string;
let home: string;

/** 부르면 세고 실패하는 원격. 로컬에서는 한 번도 불리지 않아야 한다 */
let remoteCalls: string[] = [];
const called = (name: string): never => {
  remoteCalls.push(name);
  throw new Error(`원격을 불렀다: ${name}`);
};
const noRemote: RemoteProvider = {
  cloneUrl: () => called("cloneUrl"),
  fileUrl: () => called("fileUrl"),
  verify: async () => called("verify"),
  listRepos: async () => called("listRepos"),
  createPullRequest: async () => called("createPullRequest"),
  listOpenPullRequests: async () => called("listOpenPullRequests"),
  getLatestRelease: async () => called("getLatestRelease"),
  downloadReleaseAsset: async () => called("downloadReleaseAsset"),
  commitFiles: async () => called("commitFiles"),
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", ["-c", "user.name=Other", "-c", "user.email=o@example.test", ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } })
    .toString()
    .trim();

interface Fixture {
  ws: WorkspaceService;
  localDir: string;
  /** 설정에 저장된 출처 */
  saved: () => WorkspaceSourceKind;
  setBusy: (reason: string | null) => void;
  /** Finder 에서 연 폴더 */
  opened: string[];
}

function fixture(name: string, source: WorkspaceSourceKind = "local"): Fixture {
  const root = join(dir, name);
  const localDir = join(root, "local-workspace");
  mkdirSync(root, { recursive: true });
  let current = source;
  let busy: string | null = null;
  const opened: string[] = [];
  const ws = new WorkspaceService({
    root: join(root, "workspaces"),
    source: () => current,
    saveSource: (next) => {
      current = next;
    },
    localDir,
    localAuthor: AUTHOR,
    remote: noRemote,
    github: () => ({ owner: "acme", workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-", evidenceRepo: null, evidenceOwner: null }),
    token: () => null,
    askpass: () => Promise.reject<AskpassServer>(new Error("로컬에서는 git 인증 도우미를 쓰지 않는다")),
    home,
    busy: () => busy,
    checkFlowSyntax: () => Promise.resolve(),
    openFolder: (path) => {
      opened.push(path);
      return Promise.resolve("");
    },
  });
  return { ws, localDir, saved: () => current, setBusy: (reason) => (busy = reason), opened };
}

const FLOW = ['appId: ${APP_ID}', "name: TC-0001 첫 화면", "tags: [TC-0001]", "---", "- runFlow: common/launch-clean.yaml", '- assertVisible: "시작"', ""].join("\n");
const META = ["tc: TC-0001", "tcVersion: abc1234", "target: ios", "generatedBy: human", ""].join("\n");
const SUBFLOW_NAMES = ["close-keyboard.yaml", "dismiss-system-prompts.yaml", "launch-clean.yaml"];
const committedFiles = (repo: string, rev = "HEAD") => git(repo, "show", "--name-only", "--format=", rev).split("\n").filter(Boolean).sort();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-wslocal-"));
  home = join(dir, "home");
  mkdirSync(home);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("로컬 워크스페이스 (ADR 0036)", { timeout: 30_000 }, () => {
  it("빈 워크스페이스에서 첫 앱 등록 → TC 저장 → 플로우 저장 → 실행할 플로우 찾기까지 원격 없이 main 에 바로 저장한다", async () => {
    remoteCalls = [];
    const { ws, localDir } = fixture("journey");

    // 화면이 처음 부르는 상태 읽기가 저장소를 만든다. 앱 없이 시작한다
    expect(await ws.status()).toEqual({ source: "local", connected: true, repo: null, branch: "main", head: expect.any(String), onMain: true, dirty: [], ahead: 0, behind: 0, issues: 0, layout: 2, location: localDir });
    expect(await ws.testcases()).toEqual({ testcases: [], apps: [], issues: [] });
    expect(ws.accounts()).toEqual({ connected: true, apps: [] });

    // 첫 앱: 앱 설정과 함께 그 타깃의 공통 서브플로우 기본 파일이 같은 커밋에 들어간다
    const app = await ws.saveApp({ app: "first", create: true, name: "First", locale: null, targets: [{ target: "ios", appId: "com.example.first" }], roles: [], summary: "first app" });
    expect(app.branch).toBe("main");
    expect(committedFiles(localDir)).toEqual(["apps/first/app.yaml", ...SUBFLOW_NAMES.map((n) => `apps/first/flows/ios/common/${n}`), "workspace.yaml"]);
    expect(readFileSync(join(localDir, "workspace.yaml"), "utf8")).toContain("apps: [first]");
    expect((await ws.subflows("first")).subflows.map((s) => [s.target, s.name])).toEqual(SUBFLOW_NAMES.map((n) => ["ios", n]));
    expect(await ws.testcases()).toMatchObject({ apps: [{ app: "first", name: "First", targets: ["ios"], accountRoles: [] }], issues: [] });

    const tc = await ws.saveTestcase({ app: "first", id: "TC-0001", text: testcaseTemplate({ id: "TC-0001", app: "first", targets: ["ios"] }), summary: "new tc" });
    expect(tc.branch).toBe("main");
    expect(tc.status).toMatchObject({ source: "local", branch: "main", onMain: true, dirty: [], ahead: 0, behind: 0, issues: 0 });
    expect(committedFiles(localDir)).toEqual(["apps/first/testcases/TC-0001.md"]);

    // 플로우 만들기가 쓰는 길: 입력 조립(기본 서브플로우가 보인다) → main 에 커밋. 같은 내용을 다시 저장하면 새 커밋이 없다
    expect(await ws.useTestcaseBranch("TC-0001")).toBe("main");
    const ctx = await ws.authorContext("first", "TC-0001", "ios");
    expect(ctx.subflows.map((f) => f.path)).toEqual(SUBFLOW_NAMES.map((n) => `common/${n}`));
    const flow = { id: "TC-0001", flowPath: ctx.flowPath, metaPath: ctx.metaPath, yaml: FLOW, meta: META, summary: "agent flow" };
    const saved = await ws.saveFlow(flow);
    expect(saved).toEqual({ branch: "main", commit: git(localDir, "rev-parse", "--short", "HEAD"), unchanged: false });
    expect(await ws.saveFlow(flow)).toEqual({ ...saved, unchanged: true });
    expect(committedFiles(localDir)).toEqual(["apps/first/flows/ios/TC-0001.meta.yaml", "apps/first/flows/ios/TC-0001.yaml"]);

    // 승인 단계가 없다: 저장한 플로우가 바로 실행 대상이다
    expect(ws.runPlan({ app: "first", target: "ios", tcIds: ["TC-0001"] })).toMatchObject({ appId: "com.example.first", flows: [{ tcId: "TC-0001", path: join(localDir, "apps/first/flows/ios/TC-0001.yaml"), envKeys: [] }] });
    expect((await ws.testcases()).testcases).toMatchObject([{ app: "first", id: "TC-0001", valid: true, flows: ["ios"] }]);
    expect(await ws.history("first", "TC-0001")).toMatchObject([{ author: AUTHOR, subject: "tc: TC-0001 new tc" }]);

    // 읽기만 하는 Git 화면용 목록은 거절하지 않고 비어 있다
    expect(await ws.branches()).toEqual({ current: "main", branches: [] });
    expect(await ws.myPullRequests()).toEqual([]);
    expect(await ws.checkout("main")).toMatchObject({ source: "local", repo: null, branch: "main", dirty: [] });

    // 모든 커밋이 main 에 있고, 브랜치는 main 하나, 원격은 없고, 작성자는 이 Mac 의 이름과 GitHub 것이 아닌 주소다
    expect(git(localDir, "log", "--format=%s|%an|%ae", "main").split("\n").reverse()).toEqual([
      `workspace: 로컬 워크스페이스를 만든다|${AUTHOR}|${AUTHOR}@avocado.local`,
      `app: first first app|${AUTHOR}|${AUTHOR}@avocado.local`,
      `tc: TC-0001 new tc|${AUTHOR}|${AUTHOR}@avocado.local`,
      `flow: TC-0001 agent flow|${AUTHOR}|${AUTHOR}@avocado.local`,
    ]);
    expect(git(localDir, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(git(localDir, "remote")).toBe("");
    expect(git(localDir, "log", "--all", "--format=%ae%n%ce")).not.toContain("github.com");
    expect(remoteCalls).toEqual([]);
  });

  it("테스트 케이스·태그 실행은 그 TC 계정 역할의 키만 넘기고, 역할이 없는 TC 에는 아무 키도 넘기지 않는다", async () => {
    const { ws } = fixture("role-keys");
    await ws.status();
    await ws.saveApp({
      app: "two",
      create: true,
      name: "Two",
      locale: null,
      targets: [{ target: "ios", appId: "com.example.two" }],
      roles: [
        { role: "signup", description: "가입", keys: ["TWO_SIGNUP_PASSWORD"] },
        { role: "admin", description: "관리자", keys: ["TWO_ADMIN_ID", "TWO_ADMIN_PW"] },
      ],
      summary: "two roles",
    });
    for (const [id, account] of [["TC-0001", "signup"], ["TC-0002", undefined]] as const) {
      const text = testcaseTemplate({ id, app: "two", targets: ["ios"], account }).replace("status: draft", "tags: [smoke]\nstatus: active");
      await ws.saveTestcase({ app: "two", id, text, summary: id });
      const ctx = await ws.authorContext("two", id, "ios");
      await ws.saveFlow({ id, flowPath: ctx.flowPath, metaPath: ctx.metaPath, yaml: FLOW.replaceAll("TC-0001", id), meta: META.replace("TC-0001", id), summary: id });
    }

    const started: QueuedRun["options"][] = [];
    const queue = new RunQueue({
      start: (_input, options) => {
        started.push(options);
        return Promise.resolve({ id: `run-${started.length}` } as RunSummary);
      },
      wait: () => Promise.resolve(),
      cancel: (id) => ({ id }) as RunSummary,
      summary: (id) => ({ id, status: "passed" }) as RunSummary,
    });
    const sim = { id: "SIM", platform: "ios", kind: "simulator", name: "Sim", osVersion: "18.0", state: "booted", managed: true, serial: null, locale: null } as const;
    const handlers = createWorkspaceRunHandlers({
      workspace: ws,
      builds: { get: () => { throw new Error("빌드 없음"); } },
      devices: { list: () => Promise.resolve({ devices: [sim] }) },
      queue,
      iosDeviceProblem: () => Promise.resolve(null),
      deviceBusy: () => null,
    });
    await handlers["runs:startFromWorkspace"]({ app: "two", target: "ios", tag: "smoke", deviceId: "SIM", buildId: null });
    await queue.idle();
    expect(started).toEqual([
      { appId: "com.example.two", envKeys: ["TWO_SIGNUP_PASSWORD"], trigger: "manual" },
      { appId: "com.example.two", envKeys: [], trigger: "manual" },
    ]);
  });

  it("타깃을 더하면 그 타깃의 기본 서브플로우만 만들고, 이미 있는 파일은 덮어쓰지 않는다", async () => {
    const { ws, localDir } = fixture("targets");
    await ws.status();
    const ios = { target: "ios" as const, appId: "com.example.second" };
    const android = { target: "android" as const, appId: "com.example.second" };
    const base = { app: "second", create: false, name: "Second", locale: null, roles: [] };
    await ws.saveApp({ ...base, create: true, targets: [ios], summary: "second app" });

    // 사람이 고친 iOS 서브플로우와, 먼저 넣어 둔 Android 서브플로우
    const launch = (await ws.subflows("second")).subflows.find((s) => s.name === "launch-clean.yaml");
    if (!launch) throw new Error("launch-clean.yaml 이 없다");
    const edited = `${launch.text}- extendedWaitUntil:\n    visible: "시작"\n    timeout: 15000\n`;
    await ws.saveSubflow({ app: "second", target: "ios", name: "launch-clean.yaml", text: edited, summary: "wait for first screen" });
    const mine = "appId: ${APP_ID}\n---\n- launchApp\n";
    mkdirSync(join(localDir, "apps/second/flows/android/common"), { recursive: true });
    writeFileSync(join(localDir, "apps/second/flows/android/common/launch-clean.yaml"), mine);
    git(localDir, "add", ".");
    git(localDir, "commit", "-q", "-m", "my android launch");

    await ws.saveApp({ ...base, targets: [ios, android], summary: "add android" });
    expect(committedFiles(localDir)).toEqual(["apps/second/app.yaml", "apps/second/flows/android/common/close-keyboard.yaml", "apps/second/flows/android/common/dismiss-system-prompts.yaml"]);
    expect(readFileSync(join(localDir, "apps/second/flows/android/common/launch-clean.yaml"), "utf8")).toBe(mine);
    expect(readFileSync(join(localDir, "apps/second/flows/ios/common/launch-clean.yaml"), "utf8")).toBe(edited);
    expect(readdirSync(join(localDir, "apps/second/flows/android/common")).sort()).toEqual(SUBFLOW_NAMES);

    // 타깃이 그대로면 앱 설정만 바뀐다
    await ws.saveApp({ ...base, name: "Second App", targets: [ios, android], summary: "rename" });
    expect(committedFiles(localDir)).toEqual(["apps/second/app.yaml"]);
    expect((await ws.status()).dirty).toEqual([]);
  });

  it("원격이 필요한 기능은 같은 안내로 거절하고 원격을 부르지 않는다", async () => {
    remoteCalls = [];
    const { ws, localDir } = fixture("refusals");
    await ws.status();
    const head = git(localDir, "rev-parse", "HEAD");
    const refused = [
      ws.connect(),
      ws.sync(),
      ws.requestReview({ title: "t", body: "b" }),
      ws.requestReview({ title: "t", body: "b", branch: `qa/${AUTHOR}/TC-0001-x` }),
      ws.checkout(`qa/${AUTHOR}/TC-0001-x`),
      ws.migrateLayout(),
    ];
    for (const attempt of refused) {
      const error = await attempt.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(WorkspaceError);
      expect(String(error)).toMatch(LOCAL_REFUSAL);
    }
    expect(git(localDir, "rev-parse", "HEAD")).toBe(head);
    expect(git(localDir, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(remoteCalls).toEqual([]);
  });

  it("로컬 저장소가 main 이 아니면 다른 브랜치에 커밋하지 않고 알린다", async () => {
    const { ws, localDir } = fixture("off-main");
    await ws.status();
    await ws.saveApp({ app: "first", create: true, name: "First", locale: null, targets: [{ target: "ios", appId: "com.example.first" }], roles: [], summary: "first app" });
    git(localDir, "switch", "-q", "-c", "side");
    const head = git(localDir, "rev-parse", "HEAD");
    await expect(ws.saveTestcase({ app: "first", id: "TC-0001", text: testcaseTemplate({ id: "TC-0001", app: "first", targets: ["ios"] }), summary: "new tc" })).rejects.toThrow(/main 브랜치가 아니다\(side\)/);
    expect(git(localDir, "rev-parse", "HEAD")).toBe(head);
    expect(git(localDir, "status", "--porcelain")).toBe("");
  });
});

describe("로컬 저장소 만들기 ensureLocal (ADR 0036 결정 3)", { timeout: 30_000 }, () => {
  it("여러 번, 동시에 불러도 첫 커밋 하나인 저장소가 하나 생긴다", async () => {
    const { ws, localDir } = fixture("ensure-twice");
    expect(existsSync(localDir)).toBe(false);
    await Promise.all([ws.ensureLocal(), ws.ensureLocal()]);
    await ws.ensureLocal();
    await ws.status();
    expect(git(localDir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(localDir, "ls-files")).toBe("workspace.yaml");
    expect(git(localDir, "status", "--porcelain")).toBe("");
    // 팀용 파일(CODEOWNERS, PR 템플릿)은 만들지 않는다
    expect(readdirSync(localDir).sort()).toEqual([".git", "workspace.yaml"]);
  });

  it("만들다 멈춘 임시 폴더가 남아 있어도 제자리에는 쓸 수 있는 저장소만 생긴다", async () => {
    const { ws, localDir } = fixture("ensure-leftover");
    // 이전 시도가 git init 뒤, 첫 커밋 전에 멈췄다
    const leftover = `${localDir}.creating`;
    mkdirSync(leftover, { recursive: true });
    git(leftover, "init", "-q", "-b", "main");
    writeFileSync(join(leftover, "half-written.txt"), "x");
    await ws.ensureLocal();
    expect(existsSync(leftover)).toBe(false);
    expect(git(localDir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(readdirSync(localDir).sort()).toEqual([".git", "workspace.yaml"]);
    expect(await ws.status()).toMatchObject({ connected: true, branch: "main", issues: 0 });
  });

  it("그 자리에 git 저장소가 아닌 폴더가 있으면 건드리지 않고 알린다", async () => {
    const { ws, localDir } = fixture("ensure-not-git");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "notes.txt"), "내 파일");
    await expect(ws.ensureLocal()).rejects.toThrow(WorkspaceError);
    await expect(ws.status()).rejects.toThrow(/git 저장소가 아니다/);
    expect(readdirSync(localDir)).toEqual(["notes.txt"]);
  });
});

describe("출처 바꾸기 workspace:setSource (ADR 0036 결정 10)", { timeout: 30_000 }, () => {
  it("실행·플로우 만들기 중에는 거절하고 아무것도 바꾸지 않는다", async () => {
    const { ws, localDir, saved, setBusy } = fixture("source-busy", "github");
    setBusy("플로우 실행이 진행 중이다");
    await expect(ws.setSource("local")).rejects.toThrow(/플로우 실행이 진행 중이다.*출처를 바꾼다/);
    expect(saved()).toBe("github");
    expect(existsSync(localDir)).toBe(false);
    setBusy(null);
    expect(await ws.setSource("local")).toMatchObject({ source: "local", connected: true });
  });

  it("로컬로 바꾸면 저장소를 만들고, GitHub 로 돌아가도 로컬 폴더와 내용은 그대로다", async () => {
    remoteCalls = [];
    const { ws, localDir, saved } = fixture("source-switch", "github");
    const handlers = createWorkspaceHandlers(ws);
    expect(await ws.status()).toMatchObject({ source: "github", connected: false, repo: "acme/qa-workspace" });
    expect(existsSync(localDir)).toBe(false);

    expect(await handlers["workspace:setSource"]({ source: "local" })).toMatchObject({ source: "local", connected: true, repo: null, branch: "main" });
    expect(saved()).toBe("local");
    await ws.saveApp({ app: "first", create: true, name: "First", locale: null, targets: [{ target: "android", appId: "com.example.first" }], roles: [], summary: "first app" });
    const head = git(localDir, "rev-parse", "HEAD");

    expect(await handlers["workspace:setSource"]({ source: "github" })).toMatchObject({ source: "github", connected: false, repo: "acme/qa-workspace" });
    expect(saved()).toBe("github");
    expect(git(localDir, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(localDir, "apps/first/app.yaml"))).toBe(true);

    // 다시 로컬로 오면 만든 것이 그대로 보인다
    await handlers["workspace:setSource"]({ source: "local" });
    expect((await ws.testcases()).apps.map((a) => a.app)).toEqual(["first"]);
    expect(git(localDir, "rev-parse", "HEAD")).toBe(head);
    expect(remoteCalls).toEqual([]);
  });

  it("IPC 입력은 local·github 만 받는다", () => {
    expect(SetWorkspaceSourceInputSchema.safeParse({ source: "local" }).success).toBe(true);
    expect(SetWorkspaceSourceInputSchema.safeParse({ source: "gitlab" }).success).toBe(false);
    expect(SetWorkspaceSourceInputSchema.safeParse({ source: "local", dir: "/tmp" }).success).toBe(false);
  });

  it("Finder 에서 열기는 서비스가 아는 로컬 폴더만 열고, GitHub 워크스페이스에서는 거절한다", async () => {
    const local = fixture("reveal-local");
    expect(await createWorkspaceHandlers(local.ws)["workspace:reveal"](undefined)).toEqual({ opened: true });
    expect(local.opened).toEqual([local.localDir]);

    const github = fixture("reveal-github", "github");
    await expect(github.ws.reveal()).rejects.toThrow(/Finder 에서 열기: GitHub 워크스페이스에서는 쓸 수 없다/);
    expect(github.opened).toEqual([]);
    expect(await github.ws.status()).toMatchObject({ source: "github", location: null });
  });

  it("화면에 보이는 폴더는 홈 아래면 ~ 로 줄인다", () => {
    expect(displayPath("/Users/qa/Library/Application Support/Avocado/local-workspace", "/Users/qa")).toBe("~/Library/Application Support/Avocado/local-workspace");
    expect(displayPath("/Users/qa/x", "/Users/qa/")).toBe("~/x");
    expect(displayPath("/Users/qa", "/Users/qa")).toBe("~");
    expect(displayPath("/Users/qaz/x", "/Users/qa")).toBe("/Users/qaz/x");
    expect(displayPath("/tmp/local-workspace", "/Users/qa")).toBe("/tmp/local-workspace");
  });
});
