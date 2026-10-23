import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskpassServer, GitHubProvider } from "@qa/remote";
import { startFakeGitHub, type FakeGitHub } from "../../../../../packages/remote/src/testing/fake-github";
import { startGitHttp } from "../../../../../packages/remote/src/testing/git-http";
import { branchSlug, WorkspaceService } from "./workspace-service";

const TOKEN = "github_pat_WS_0123456789abcdefghijklmnopqrstuvwxyz";
const EXAMPLE = resolve(__dirname, "../../../../../examples/qa-workspace");
let dir: string;
let home: string;
let bare: string;
let fake: FakeGitHub;
let server: Awaited<ReturnType<typeof startGitHttp>>;
let askpass: AskpassServer;
let ws: WorkspaceService;
/** 진행 중인 실행·플로우 만들기(작업 브랜치를 바꾸지 못하게 한다) */
let busyReason: string | null = null;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", ["-c", "user.name=Other", "-c", "user.email=o@example.test", ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } })
    .toString()
    .trim();
const wsDir = () => join(dir, "workspaces", "qa-workspace");
function allFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    const st = statSync(p, { throwIfNoEntry: false });
    return !st ? [] : st.isDirectory() ? allFiles(p) : [p];
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "qa-wssvc-"));
  home = join(dir, "home");
  mkdirSync(home);
  const seed = join(dir, "seed");
  cpSync(EXAMPLE, seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "template");
  bare = join(dir, "srv", "acme", "qa-workspace.git");
  mkdirSync(join(dir, "srv", "acme"), { recursive: true });
  git(dir, "clone", "-q", "--bare", seed, bare);
  git(bare, "config", "http.receivepack", "true");
  server = await startGitHttp({ root: join(dir, "srv"), password: TOKEN });
  fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-workspace": { push: true } } });
  askpass = await AskpassServer.start();
  ws = new WorkspaceService({
    root: join(dir, "workspaces"),
    remote: new GitHubProvider({ token: () => TOKEN, apiUrl: fake.url, webUrl: server.url }),
    github: () => ({ owner: "acme", workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-", appRepo: "qa-tool" }),
    token: () => TOKEN,
    askpass: () => Promise.resolve(askpass),
    home,
    busy: () => busyReason,
  });
});
afterAll(async () => {
  await server.close();
  await fake.close();
  await askpass.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("워크스페이스", () => {
  it("연결: clone 하고 상태와 TC 목록을 보여 준다", async () => {
    expect(await ws.status()).toMatchObject({ connected: false, repo: "acme/qa-workspace" });
    // 연결 전에는 계정 키 목록이 비어 있다(설정 화면은 직접 입력만 보인다)
    expect(ws.accounts()).toEqual({ connected: false, apps: [] });
    const s = await ws.connect();
    expect(s).toMatchObject({ connected: true, branch: "main", onMain: true, dirty: [], ahead: 0, behind: 0, issues: 0 });
    const list = ws.testcases();
    expect(list.issues).toEqual([]);
    expect(list.apps).toEqual([
      { app: "demo", name: "Demo", targets: ["ios"], accountRoles: ["signup"] },
      { app: "sample", name: "Sample", targets: ["ios"], accountRoles: ["student"] },
    ]);
    // 앱마다 필요한 계정 값의 키 이름(값은 없다)
    const accounts = ws.accounts();
    expect(accounts.connected).toBe(true);
    expect(accounts.apps.find((a) => a.app === "demo")).toEqual({
      app: "demo",
      name: "Demo",
      roles: [{ role: "signup", description: expect.stringContaining("비밀번호"), keys: ["DEMO_TEST_PASSWORD"] }],
    });
    expect(accounts.apps.find((a) => a.app === "sample")?.roles.map((r) => r.role)).toEqual(["student"]);
    expect(list.testcases.map((t) => [t.app, t.id, t.valid, t.flows])).toEqual([
      ["demo", "TC-0101", true, ["ios"]],
      ["sample", "TC-0002", true, ["ios"]],
    ]);
    expect(readFileSync(join(wsDir(), ".git", "config"), "utf8")).toContain(`url = ${server.url}/acme/qa-workspace.git`);
  });

  it("TC 저장: main 이면 작업 브랜치를 만들어 커밋한다", async () => {
    const { text } = ws.readTestcase("demo", "TC-0101");
    const edited = text.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고");
    const r = await ws.saveTestcase({ app: "demo", id: "TC-0101", text: edited, summary: "signup expected text" });
    expect(r.branch).toBe("qa/qa-bot/TC-0101-signup-expected-text");
    expect(r.status).toMatchObject({ onMain: false, dirty: [], ahead: 1, behind: 0 });
    expect(git(wsDir(), "log", "-1", "--format=%s|%an|%ae")).toBe("tc: TC-0101 signup expected text|qa-bot|qa-bot@users.noreply.github.com");
    // 같은 브랜치에서 한 번 더 저장하면 브랜치를 새로 만들지 않는다
    const again = await ws.saveTestcase({ app: "demo", id: "TC-0101", text: edited.replace("QA", "QA"), summary: "noop" }).catch((e: unknown) => String(e));
    expect(again).toMatch(/바뀐 내용이 없다/);
  });

  it("형식이 틀리거나 위치가 다른 TC, 경로를 벗어나는 id 는 커밋하지 않는다", async () => {
    const head = git(wsDir(), "rev-parse", "HEAD");
    const before = readFileSync(join(wsDir(), "testcases", "demo", "TC-0101.md"), "utf8");
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0101", text: "## 스텝\n1. x", summary: "broken" })).rejects.toThrow(/TC 형식 오류/);
    // 린트 차단(PLAN 4.2): 기대 없는 스텝, accounts.yaml 에 없는 역할
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0101", text: before.replace(/ {3}- 기대: 홈 화면.*\n/, ""), summary: "no expected" })).rejects.toThrow(/린트 오류.*기대/);
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0101", text: before.replace("account: signup", "account: admin"), summary: "bad role" })).rejects.toThrow(/린트 오류.*admin/);
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0102", text: before, summary: "wrong id" })).rejects.toThrow(/저장 위치와 다르다/);
    await expect(ws.saveTestcase({ app: "../x", id: "TC-0101", text: before, summary: "x" })).rejects.toThrow(/형식이 아니다/);
    expect(git(wsDir(), "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(wsDir(), "testcases", "demo", "TC-0101.md"), "utf8")).toBe(before);
  });

  it("PR 작성: 작업 브랜치를 푸시하고 PR 을 만든다. 토큰은 워크스페이스 어디에도 없다", async () => {
    const r = await ws.requestReview({ title: "TC-0101 기대 결과 문구", body: "골든 런: 미실행" });
    expect(r).toEqual({ number: 7, url: "https://github.com/acme/qa-workspace/pull/7", branch: "qa/qa-bot/TC-0101-signup-expected-text", existing: false });
    expect(fake.pulls).toEqual([{ repo: "acme/qa-workspace", head: r.branch, base: "main", title: "TC-0101 기대 결과 문구", body: "골든 런: 미실행" }]);
    expect(git(bare, "branch", "--list", "qa/*")).toContain("qa/qa-bot/TC-0101-signup-expected-text");
    expect(git(bare, "log", "-1", "--format=%s", "main")).toBe("template"); // main 은 그대로
    const leaked = allFiles(join(dir, "workspaces")).filter((f) => readFileSync(f).includes(Buffer.from(TOKEN)));
    expect(leaked).toEqual([]);
    // 홈 화면의 내 PR: 내가 만든 열린 PR
    expect(await ws.myPullRequests()).toEqual([{ number: 7, title: "TC-0101 기대 결과 문구", url: "https://github.com/acme/qa-workspace/pull/7", branch: r.branch, createdAt: "2026-10-22T00:00:00Z" }]);
  });

  it("변경 내역: TC 파일의 커밋", async () => {
    const h = await ws.history("demo", "TC-0101");
    expect(h.map((c) => c.subject)).toEqual(["tc: TC-0101 signup expected text", "template"]);
    expect(h[0]).toMatchObject({ author: "qa-bot", commit: expect.stringMatching(/^[0-9a-f]{7,}$/) });
  });

  it("동기화: 작업 브랜치는 그대로 두고, main 이고 깨끗할 때만 fast-forward 한다", async () => {
    const other = join(dir, "other");
    git(dir, "clone", "-q", bare, other);
    writeFileSync(join(other, "README.md"), "# 다른 사람이 바꿈\n");
    git(other, "commit", "-q", "-am", "readme");
    git(other, "push", "-q", "origin", "main");

    const onBranch = await ws.sync();
    expect(onBranch).toMatchObject({ onMain: false, behind: 1 });
    git(wsDir(), "checkout", "-q", "main");
    const onMain = await ws.sync();
    expect(onMain).toMatchObject({ onMain: true, behind: 0, ahead: 0 });
    expect(readFileSync(join(wsDir(), "README.md"), "utf8")).toBe("# 다른 사람이 바꿈\n");
  });

  it("main 에서는 PR 을 만들지 않는다", async () => {
    await expect(ws.requestReview({ title: "x", body: "" })).rejects.toThrow(/main 에서는/);
  });

  it("플로우 만들기: 입력 조립, 초안 쓰기·되돌리기, 작업 브랜치에 플로우·meta 커밋", async () => {
    git(wsDir(), "checkout", "-q", "main");
    const ctx = await ws.authorContext("demo", "TC-0101", "ios");
    expect(ctx).toMatchObject({
      flowPath: "flows/demo/ios/TC-0101.yaml",
      metaPath: "flows/demo/ios/TC-0101.meta.yaml",
      envKeys: ["DEMO_TEST_PASSWORD"],
      appId: "com.example.demo",
      locale: "ko_KR",
      tc: { id: "TC-0101", steps: 2, expectations: 2 },
    });
    expect(ctx.subflows.map((f) => f.path)).toEqual(["common/launch-clean.yaml"]);
    expect(ctx.tcVersion).toMatch(/^[0-9a-f]{7,}$/);
    await expect(ws.authorContext("demo", "TC-0101", "android")).rejects.toThrow("targets 에 android 가 없다");

    const original = readFileSync(join(wsDir(), ctx.flowPath), "utf8");
    const draft = ws.writeFlowDraft(ctx.flowPath, "appId: ${APP_ID}\n---\n- launchApp\n");
    expect(draft.previous).toBe(original);
    ws.restoreFlowDraft(ctx.flowPath, draft.previous);
    expect(readFileSync(join(wsDir(), ctx.flowPath), "utf8")).toBe(original);
    expect((await ws.status()).dirty).toEqual([]);
    expect(() => ws.writeFlowDraft("flows/demo/ios/../../../../x.yaml", "x")).toThrow("플로우 경로 형식");
    // 심볼릭 링크 폴더로 워크스페이스 밖에 쓰지 않는다
    const outside = mkdtempSync(join(tmpdir(), "qa-outside-"));
    symlinkSync(outside, join(wsDir(), "flows", "demo", "android"));
    expect(() => ws.writeFlowDraft("flows/demo/android/TC-0101.yaml", "x")).toThrow("워크스페이스 밖");
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(wsDir(), "flows", "demo", "android"));

    const saved = await ws.saveFlow({ id: "TC-0101", flowPath: ctx.flowPath, metaPath: ctx.metaPath, yaml: original.replace("QA봇", "QA봇2"), meta: "tc: TC-0101\n", summary: "agent flow" });
    // main 에서 시작해도 main 에 아직 없는 이 TC 의 작업 브랜치(앞의 TC 저장)가 있으면 그 브랜치에 모은다
    expect(saved.branch).toBe("qa/qa-bot/TC-0101-signup-expected-text");
    expect(git(wsDir(), "log", "-1", "--format=%s")).toBe("flow: TC-0101 agent flow");
    expect(git(wsDir(), "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([ctx.metaPath, ctx.flowPath]);
    expect(saved.unchanged).toBe(false);

    // 같은 플로우·meta 를 다시 저장하면 새 커밋 없이 그 커밋을 돌려준다(실패가 아니다)
    const again = await ws.saveFlow({ id: "TC-0101", flowPath: ctx.flowPath, metaPath: ctx.metaPath, yaml: original.replace("QA봇", "QA봇2"), meta: "tc: TC-0101\n", summary: "agent flow" });
    expect(again).toEqual({ branch: saved.branch, commit: saved.commit, unchanged: true });
    expect(git(wsDir(), "rev-parse", "--short", "HEAD")).toBe(saved.commit);

    // main 에서 시작했는데 main 과 같으면(이미 승인된 플로우) 빈 작업 브랜치를 남기지 않고 main 을 돌려준다.
    // 이 TC 의 작업 브랜치가 없을 때다(머지 뒤 지운 것으로 둔다)
    git(wsDir(), "checkout", "-q", "main");
    git(wsDir(), "branch", "-q", "-D", saved.branch);
    const mainMeta = readFileSync(join(wsDir(), ctx.metaPath), "utf8");
    const before = git(wsDir(), "branch", "--list", "qa/*");
    const same = await ws.saveFlow({ id: "TC-0101", flowPath: ctx.flowPath, metaPath: ctx.metaPath, yaml: original, meta: mainMeta, summary: "agent flow" });
    expect(same).toEqual({ branch: "main", commit: git(wsDir(), "rev-parse", "--short", "main"), unchanged: true });
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(wsDir(), "branch", "--list", "qa/*")).toBe(before);
    expect((await ws.status()).dirty).toEqual([]);
  });

  it("실행할 플로우 찾기: TC 하나 또는 태그(active TC), 없는 플로우는 알린다", () => {
    git(wsDir(), "checkout", "-q", "main");
    const one = ws.flowsToRun({ app: "demo", target: "ios", tcId: "TC-0101" });
    expect(one.appId).toBe("com.example.demo");
    expect(one.flows).toEqual([{ tcId: "TC-0101", path: join(wsDir(), "flows/demo/ios/TC-0101.yaml") }]);
    expect(ws.flowsToRun({ app: "demo", target: "ios", tag: "smoke" }).flows.map((f) => f.tcId)).toEqual(["TC-0101"]);
    expect(() => ws.flowsToRun({ app: "demo", target: "android", tcId: "TC-0101" })).toThrow("플로우가 없다");
    expect(() => ws.flowsToRun({ app: "demo", target: "ios", tag: "nothing" })).toThrow("태그 nothing");
  });

  it("작업 브랜치는 TC 마다 따로: 다른 TC 의 작업 브랜치에 섞지 않는다", async () => {
    git(wsDir(), "checkout", "-q", "main");
    const tc101 = readFileSync(join(wsDir(), "testcases", "demo", "TC-0101.md"), "utf8");
    const tc102 = tc101.replaceAll("TC-0101", "TC-0102");
    const a = await ws.saveTestcase({ app: "demo", id: "TC-0101", text: tc101.replace("홈 화면이 열리고", "홈 화면(A)이 열리고"), summary: "tc one" });
    expect(a.branch).toBe("qa/qa-bot/TC-0101-tc-one");
    const aHead = git(wsDir(), "rev-parse", a.branch);

    // TC-0101 의 브랜치에 있는 채로 새 TC-0102 를 저장하면 main 에서 TC-0102 의 브랜치를 새로 만든다
    const b = await ws.saveTestcase({ app: "demo", id: "TC-0102", text: tc102, summary: "add TC-0102" });
    expect(b.branch).toBe("qa/qa-bot/TC-0102-add-tc-0102");
    expect(git(wsDir(), "rev-parse", `${b.branch}^`)).toBe(git(wsDir(), "rev-parse", "main"));
    expect(git(wsDir(), "rev-parse", a.branch)).toBe(aHead);
    expect(git(wsDir(), "ls-tree", "--name-only", a.branch, "testcases/demo/")).not.toContain("TC-0102");

    // TC-0102 의 브랜치에 있는 채로 TC-0101 을 고치면 TC-0101 의 브랜치로 옮겨 커밋한다
    const c = await ws.saveTestcase({ app: "demo", id: "TC-0101", text: tc101.replace("홈 화면이 열리고", "홈 화면(B)이 열리고"), summary: "tc one again" });
    expect(c.branch).toBe(a.branch);
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(a.branch);
    expect(git(wsDir(), "log", "--format=%s", `main..${a.branch}`).split("\n")).toEqual(["tc: TC-0101 tc one again", "tc: TC-0101 tc one"]);

    // 플로우 만들기를 시작할 때: 이 TC 의 브랜치로, 없으면 main 으로
    expect(await ws.useTestcaseBranch("TC-0102")).toBe(b.branch);
    expect(await ws.useTestcaseBranch("TC-0002")).toBe("main");
    expect(await ws.useTestcaseBranch("TC-0101")).toBe(a.branch);

    // 저장하지 않은 변경이 있거나, 실행·플로우 만들기가 진행 중이면 다른 TC 의 브랜치로 옮기지 않는다
    const bHead = git(wsDir(), "rev-parse", b.branch);
    writeFileSync(join(wsDir(), "README.md"), "# 고치는 중\n");
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0102", text: tc102.replace("홈 화면이 열리고", "홈 화면(C)이 열리고"), summary: "x" })).rejects.toThrow(
      /저장하지 않은 변경이 있어 작업 브랜치를 바꾸지 않는다: README\.md/,
    );
    git(wsDir(), "checkout", "--", "README.md");
    busyReason = "플로우 실행이 진행 중이다";
    await expect(ws.checkout(b.branch)).rejects.toThrow("플로우 실행이 진행 중이다. 끝난 뒤 작업 브랜치를 바꾼다");
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0102", text: tc102.replace("홈 화면이 열리고", "홈 화면(C)이 열리고"), summary: "x" })).rejects.toThrow(/진행 중이다/);
    busyReason = null;
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(a.branch);
    expect(git(wsDir(), "rev-parse", b.branch)).toBe(bHead);

    // 내 작업 브랜치 목록과 바꾸기
    const list = await ws.branches();
    expect(list.current).toBe(a.branch);
    expect(list.branches.find((x) => x.name === b.branch)).toEqual({ name: b.branch, tcId: "TC-0102", appSettings: null, current: false, ahead: 1, subject: "tc: TC-0102 add TC-0102", pending: true });
    expect(list.branches.find((x) => x.name === a.branch)).toMatchObject({ tcId: "TC-0101", current: true, ahead: 2, pending: true });
    expect(await ws.checkout(b.branch)).toMatchObject({ branch: b.branch, onMain: false, dirty: [] });
    await expect(ws.checkout("qa/someone/TC-0101-x")).rejects.toThrow("내 작업 브랜치가 아니다");

    // PR 작성은 지금 브랜치가 아니어도 그 브랜치를 올린다(브랜치는 그대로). 같은 브랜치에 다시 요청하면 열린 PR 에 올린다
    const pulls = fake.pulls.length;
    const pr = await ws.requestReview({ title: "TC-0101", body: "", branch: a.branch });
    expect(pr).toMatchObject({ branch: a.branch, existing: false });
    expect(fake.pulls.at(-1)).toMatchObject({ head: a.branch, base: "main" });
    expect(git(bare, "rev-parse", a.branch)).toBe(git(wsDir(), "rev-parse", a.branch));
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(b.branch);
    expect(await ws.requestReview({ title: "TC-0101 again", body: "", branch: a.branch })).toEqual({ number: pr.number, url: pr.url, branch: a.branch, existing: true });
    expect(fake.pulls).toHaveLength(pulls + 1);

    // 머지되면(스쿼시 포함) 그 브랜치에 더 모으지 않는다. 같은 TC 를 다시 고치면 main 에서 새 브랜치를 만든다
    const other = join(dir, "other");
    git(other, "pull", "-q", "--ff-only", "origin", "main");
    writeFileSync(join(other, "testcases", "demo", "TC-0102.md"), tc102);
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "TC-0102 (#9)");
    git(other, "push", "-q", "origin", "main");
    await ws.checkout("main");
    await ws.sync();
    expect((await ws.branches()).branches.find((x) => x.name === b.branch)).toMatchObject({ pending: false });
    const d = await ws.saveTestcase({ app: "demo", id: "TC-0102", text: tc102.replace("홈 화면이 열리고", "홈 화면(D)이 열리고"), summary: "add TC-0102" });
    expect(d.branch).toBe(`${b.branch}-2`);
    expect(git(wsDir(), "rev-parse", `${d.branch}^`)).toBe(git(wsDir(), "rev-parse", "main"));
  });

  it("앱 설정: 검사하고 앱의 앱 설정 브랜치에 app.yaml·accounts.yaml 만 커밋해 PR 을 만든다. 새 앱도 만든다", async () => {
    git(wsDir(), "checkout", "-q", "main");
    const doc = await ws.readApp("demo");
    const signup = doc.roles[0];
    if (!signup) throw new Error("demo 의 signup 역할이 없다");
    expect(doc).toEqual({
      app: "demo",
      exists: true,
      name: "Demo",
      locale: "ko_KR",
      targets: [{ target: "ios", appId: "com.example.demo" }],
      roles: [{ role: "signup", description: expect.any(String), keys: ["DEMO_TEST_PASSWORD"] }],
      branch: null,
    });
    const base = { app: "demo", create: false, name: "Demo", locale: "ko_KR", targets: doc.targets, roles: doc.roles, summary: "x" };
    const member = { role: "member", description: "미리 만든 로그인 계정", keys: ["DEMO_MEMBER_EMAIL", "DEMO_MEMBER_PASSWORD"] };
    const android = { target: "android" as const, appId: "com.example.demo" };

    // 형식·사용 중 검사는 브랜치를 옮기기 전에 막는다(빈 브랜치가 남지 않는다)
    const head = git(wsDir(), "rev-parse", "HEAD");
    const branchesBefore = git(wsDir(), "branch", "--list", "qa/*");
    await expect(ws.saveApp({ ...base, roles: [signup, { ...member, role: "Member" }] })).rejects.toThrow(/역할 이름은 소문자/);
    await expect(ws.saveApp({ ...base, roles: [signup, { ...member, keys: ["lower"] }] })).rejects.toThrow(/키 이름은 대문자/);
    await expect(ws.saveApp({ ...base, roles: [signup, signup] })).rejects.toThrow("같은 역할 이름이 두 번 있다: signup");
    await expect(ws.saveApp({ ...base, roles: [member] })).rejects.toThrow(/TC 가 쓰는 역할은 지울 수 없다: signup\(TC-0101/);
    await expect(ws.saveApp({ ...base, roles: [{ ...signup, keys: ["DEMO_OTHER"] }] })).rejects.toThrow(
      "플로우가 쓰는 키는 지울 수 없다: DEMO_TEST_PASSWORD(flows/demo/ios/TC-0101.yaml)",
    );
    await expect(ws.saveApp({ ...base, targets: [android] })).rejects.toThrow(/TC·플로우가 쓰는 타깃은 지울 수 없다: ios\(TC-0101/);
    await expect(ws.saveApp({ ...base, targets: [...doc.targets, { target: "android", appId: "com example" }] })).rejects.toThrow("android 앱 ID 를 공백 없이 쓴다");
    await expect(ws.saveApp({ ...base, targets: [...doc.targets, ...doc.targets] })).rejects.toThrow("같은 타깃이 두 번 있다: ios");
    await expect(ws.saveApp({ ...base, locale: "korean" })).rejects.toThrow(/앱 설정 형식 오류/);
    await expect(ws.saveApp({ ...base, name: " " })).rejects.toThrow(/앱 설정 형식 오류/);
    await expect(ws.saveApp(base)).rejects.toThrow("바뀐 내용이 없다");
    await expect(ws.saveApp({ ...base, app: "nope" })).rejects.toThrow("workspace.yaml 에 없는 앱이다: nope");
    await expect(ws.saveApp({ ...base, create: true })).rejects.toThrow("이미 있는 앱이다: demo");
    expect(git(wsDir(), "rev-parse", "HEAD")).toBe(head);
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(wsDir(), "branch", "--list", "qa/*")).toBe(branchesBefore);

    // Android 타깃과 역할을 더하면 main 에서 이 앱의 앱 설정 브랜치를 만들어 두 파일만 커밋한다. 메모·주석·한 줄 키 목록은 그대로
    const saved = await ws.saveApp({ ...base, targets: [...doc.targets, android], roles: [signup, member], summary: "android and member" });
    expect(saved.branch).toBe("qa/qa-bot/app/demo/android-and-member");
    expect(git(wsDir(), "rev-parse", `${saved.branch}^`)).toBe(git(wsDir(), "rev-parse", "main"));
    expect(git(wsDir(), "show", "--name-only", "--format=%s", "HEAD").split("\n").filter(Boolean)).toEqual(["app: demo android and member", "apps/demo/accounts.yaml", "apps/demo/app.yaml"]);
    const appText = readFileSync(join(wsDir(), "apps", "demo", "app.yaml"), "utf8");
    expect(appText).toContain("note: 예시용 가상 앱");
    expect(appText).toMatch(/android:\n\s+appId: com\.example\.demo/);
    const accountsText = readFileSync(join(wsDir(), "apps", "demo", "accounts.yaml"), "utf8");
    expect(accountsText.startsWith("# 계정 역할")).toBe(true);
    expect(accountsText).toContain("keys: [DEMO_MEMBER_EMAIL, DEMO_MEMBER_PASSWORD]");
    expect(ws.testcases().apps.find((a) => a.app === "demo")).toMatchObject({ targets: ["ios", "android"], accountRoles: ["signup", "member"] });

    // 다른 브랜치로 옮겨도 진행 중인 앱 설정 브랜치에서 읽고, 다시 저장하면 그 브랜치에 쌓는다
    await ws.checkout("main");
    expect(await ws.readApp("demo")).toMatchObject({ branch: saved.branch, targets: [{ target: "ios" }, { target: "android" }] });
    const again = await ws.saveApp({ ...base, targets: [...doc.targets, { ...android, appId: "com.example.demo.app" }], roles: [signup, member], summary: "rename package" });
    expect(again.branch).toBe(saved.branch);
    expect(git(wsDir(), "log", "--format=%s", `main..${saved.branch}`).split("\n")).toEqual(["app: demo rename package", "app: demo android and member"]);
    expect((await ws.branches()).branches.find((b) => b.name === saved.branch)).toMatchObject({ tcId: null, appSettings: "demo", pending: true, ahead: 2 });

    // 예전 계정 역할 브랜치 이름(accounts/<앱>/…)도 그 앱의 앱 설정 범위다
    git(wsDir(), "checkout", "-q", "main");
    git(wsDir(), "checkout", "-q", "-b", "qa/qa-bot/accounts/sample/old-roles");
    const sampleAccounts = join(wsDir(), "apps", "sample", "accounts.yaml");
    writeFileSync(sampleAccounts, readFileSync(sampleAccounts, "utf8").replace("학생 계정", "학생 계정(예전)"));
    git(wsDir(), "commit", "-q", "-am", "old roles");
    git(wsDir(), "checkout", "-q", "main");
    expect(await ws.readApp("sample")).toMatchObject({ branch: "qa/qa-bot/accounts/sample/old-roles", roles: [{ description: expect.stringContaining("(예전)") }] });

    // PR 작성
    const pr = await ws.requestReview({ title: "demo 앱 설정", body: "", branch: saved.branch });
    expect(pr).toMatchObject({ branch: saved.branch, existing: false });
    expect(git(bare, "show", `${saved.branch}:apps/demo/app.yaml`)).toContain("android:");

    // 새 앱: workspace.yaml 앱 목록에 더하고(주석·한 줄 목록 그대로) app.yaml 을 만든다. 계정 역할이 없으면 accounts.yaml 은 만들지 않는다
    const created = await ws.saveApp({ app: "notes", create: true, name: "Notes", locale: null, targets: [{ target: "android", appId: "com.example.notes" }], roles: [], summary: "add notes app" });
    expect(created.branch).toBe("qa/qa-bot/app/notes/add-notes-app");
    expect(git(wsDir(), "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean)).toEqual(["apps/notes/app.yaml", "workspace.yaml"]);
    const wsText = readFileSync(join(wsDir(), "workspace.yaml"), "utf8");
    expect(wsText.startsWith("# qa-workspace 설정")).toBe(true);
    expect(wsText).toContain("apps: [demo, sample, notes]");
    expect(await ws.readApp("notes")).toMatchObject({ exists: true, name: "Notes", targets: [{ target: "android", appId: "com.example.notes" }], roles: [], branch: created.branch });
    expect(await ws.readApp("other")).toMatchObject({ exists: false, name: "", targets: [], roles: [] });
    git(wsDir(), "checkout", "-q", "main");
  });

  it("브랜치 요약: 영문 소문자·숫자·하이픈, 한글만 있으면 edit", () => {
    expect(branchSlug("Fix: Signup  Expected!")).toBe("fix-signup-expected");
    expect(branchSlug("기대 결과 수정")).toBe("edit");
    expect(branchSlug("a".repeat(50))).toHaveLength(30);
  });
});
