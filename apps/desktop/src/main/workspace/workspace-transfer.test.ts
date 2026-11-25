import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskpassServer, GitHubProvider, type RemoteProvider } from "@qa/remote";
import type { ImportPickResult, ImportPreview, WorkspaceSourceKind } from "@qa/shared";
import { readZip, testcaseTemplate } from "@qa/workspace";
import { startFakeGitHub, type FakeGitHub } from "../../../../../packages/remote/src/testing/fake-github";
import { startGitHttp } from "../../../../../packages/remote/src/testing/git-http";
import { buildZip } from "../../../../../packages/workspace/src/testing/zip-builder";
import { commitLocalImport } from "./import-commit";
import { workBranchScope, WorkspaceService } from "./workspace-service";

// 워크스페이스 내보내기·가져오기(ADR 0036 결정 11). 실제 git 저장소로 로컬과 GitHub 방식(가짜 원격)을 돌린다
const TOKEN = "github_pat_TRANSFER_0123456789abcdefghijklmnopqrstu";
const EXAMPLE = resolve(__dirname, "../../../../../examples/qa-workspace");
const AUTHOR = "tester";
let dir: string;
let home: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", ["-c", "user.name=Other", "-c", "user.email=o@example.test", ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } })
    .toString()
    .trim();
const files = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((p) => !p.split("/").includes(".git") && statSync(join(root, p)).isFile())
    .map((p) => relative(root, join(root, p)))
    .sort();
const committed = (repo: string, rev = "HEAD") => git(repo, "show", "--name-only", "--format=", rev).split("\n").filter(Boolean).sort();
const preview = (r: ImportPickResult): ImportPreview => {
  if (r.status !== "preview") throw new Error(`미리보기가 아니다: ${JSON.stringify(r)}`);
  return r.preview;
};
const defaults = (p: ImportPreview) => p.items.flatMap((i) => (i.defaultChoice ? [{ key: i.key, action: i.defaultChoice }] : []));

const FLOW = (id: string) => ["appId: ${APP_ID}", `name: ${id} 첫 화면`, `tags: [${id}]`, "---", "- runFlow: common/launch-clean.yaml", '- assertVisible: "일반"', ""].join("\n");
const META = (id: string) => [`tc: ${id}`, "tcVersion: abc1234", "target: ios", "generatedBy: human", ""].join("\n");

const noRemote: RemoteProvider = new Proxy({} as RemoteProvider, {
  get: (_t, name) => () => {
    throw new Error(`로컬에서 원격을 불렀다: ${String(name)}`);
  },
});

interface Picks {
  file?: string;
  folder?: string;
  save?: string;
}
const syntaxChecked: string[] = [];
function checkFlowSyntax(text: string): Promise<void> {
  syntaxChecked.push(text);
  return Promise.resolve();
}

function localFixture(name: string) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const picks: Picks = {};
  let busy: string | null = null;
  const ws = new WorkspaceService({
    root: join(root, "workspaces"),
    source: () => "local",
    saveSource: () => undefined,
    localDir: join(root, "local-workspace"),
    localAuthor: AUTHOR,
    remote: noRemote,
    github: () => ({ owner: "acme", workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-", evidenceRepo: null, evidenceOwner: null }),
    token: () => null,
    askpass: () => Promise.reject<AskpassServer>(new Error("로컬에서는 git 인증 도우미를 쓰지 않는다")),
    home,
    busy: () => busy,
    checkFlowSyntax,
    openFolder: () => Promise.resolve(""),
    pickImport: (from) => Promise.resolve((from === "file" ? picks.file : picks.folder) ?? null),
    pickExportPath: () => Promise.resolve(picks.save ?? null),
  });
  return { ws, dir: join(root, "local-workspace"), picks, setBusy: (reason: string | null) => (busy = reason) };
}

/** 설정 앱(com.apple.Preferences)과 TC-0001·플로우·meta 를 넣은 로컬 워크스페이스 */
async function seedSettings(ws: WorkspaceService): Promise<void> {
  await ws.status();
  await ws.saveApp({ app: "settings", create: true, name: "Settings", locale: null, targets: [{ target: "ios", appId: "com.apple.Preferences" }], roles: [], summary: "settings app" });
  await ws.saveTestcase({ app: "settings", id: "TC-0001", text: testcaseTemplate({ id: "TC-0001", app: "settings", targets: ["ios"] }), summary: "first" });
  await ws.saveFlow({ id: "TC-0001", flowPath: "apps/settings/flows/ios/TC-0001.yaml", metaPath: "apps/settings/flows/ios/TC-0001.meta.yaml", yaml: FLOW("TC-0001"), meta: META("TC-0001"), summary: "flow" });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-transfer-"));
  home = join(dir, "home");
  mkdirSync(home);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("로컬 워크스페이스 내보내기·가져오기", { timeout: 60_000 }, () => {
  it("내보낸 zip 을 빈 워크스페이스에 가져오면 가져올 수 있는 파일이 모두 같고, 나머지는 이유와 함께 나온다", async () => {
    const a = localFixture("roundtrip-a");
    await seedSettings(a.ws);
    // 플로우 파일 모양이 아닌 파일 두 개(내보내기에는 들어가고 가져오기는 건너뛴다)
    writeFileSync(join(a.dir, "apps/settings/flows/ios/TC-0009.yaml"), FLOW("TC-0009"));
    writeFileSync(join(a.dir, "apps/settings/notes.txt"), "메모\n");
    git(a.dir, "add", ".");
    git(a.dir, "commit", "-q", "-m", "stray");

    expect(await a.ws.exportInfo()).toEqual({ apps: 1, testcases: 1, flows: 2, subflows: 3, ref: "HEAD", fileName: expect.stringMatching(/^avocado-workspace-\d{4}-\d{2}-\d{2}\.zip$/), appNames: ["Settings"], testcaseIds: ["TC-0001"] });
    a.picks.save = join(dir, "export.zip");
    expect(await a.ws.exportZip()).toEqual({ path: join(dir, "export.zip") });
    const zip = readZip(readFileSync(join(dir, "export.zip")));
    expect(zip.ok && [...zip.files.keys()].sort()).toEqual(git(a.dir, "ls-files").split("\n").sort());
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);

    const b = localFixture("roundtrip-b");
    await b.ws.status();
    b.picks.file = join(dir, "export.zip");
    const p = preview(await b.ws.importPick("file"));
    expect(p.sourceLabel).toBe("export.zip");
    expect(p.items.map((i) => [i.key, i.status])).toEqual([
      ["app:settings", "new"],
      ["testcase:settings:TC-0001", "new"],
      ["subflow:settings:ios:close-keyboard.yaml", "new"],
      ["subflow:settings:ios:dismiss-system-prompts.yaml", "new"],
      ["subflow:settings:ios:launch-clean.yaml", "new"],
    ]);
    expect(p.skipped).toEqual([
      { path: "apps/settings/flows/ios/TC-0009.yaml", reason: "테스트 케이스 파일이 없는 플로우입니다" },
      { path: "apps/settings/notes.txt", reason: "워크스페이스 파일이 아닙니다" },
    ]);
    const before = Number(git(b.dir, "rev-list", "--count", "HEAD"));
    expect(await b.ws.importApply({ importId: p.importId, picks: defaults(p) })).toEqual({ source: "local", commit: git(b.dir, "rev-parse", "--short", "HEAD"), renumbered: [] });
    expect(Number(git(b.dir, "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(git(b.dir, "log", "-1", "--format=%an|%s")).toBe(`${AUTHOR}|import: export.zip에서 가져온다(테스트 케이스 1, 앱 설정 1, 공통 서브플로우 3)`);
    const skipped = new Set(p.skipped.map((s) => s.path));
    for (const path of git(a.dir, "ls-files", "apps").split("\n").filter((x) => !skipped.has(x))) expect(readFileSync(join(b.dir, path))).toEqual(readFileSync(join(a.dir, path)));
    expect(existsSync(join(b.dir, "apps/settings/notes.txt"))).toBe(false);
    expect(git(b.dir, "status", "--porcelain")).toBe("");
    expect(b.ws.runPlan({ app: "settings", target: "ios", tcIds: ["TC-0001"] })?.flows).toHaveLength(1);
    // 같은 미리보기로 두 번 쓰지 않는다
    await expect(b.ws.importApply({ importId: p.importId, picks: defaults(p) })).rejects.toThrow(/미리보기가 없다/);
  });

  it("고른 항목만 main 에 한 커밋으로 넣는다(그 항목이 부르는 서브플로우와 앱 설정은 함께)", async () => {
    const c = localFixture("picked");
    await c.ws.status();
    c.picks.file = join(dir, "export.zip");
    const p = preview(await c.ws.importPick("file"));
    await c.ws.importApply({ importId: p.importId, picks: [{ key: "testcase:settings:TC-0001", action: "include" }] });
    expect(committed(c.dir)).toEqual([
      "apps/settings/app.yaml",
      "apps/settings/flows/ios/TC-0001.meta.yaml",
      "apps/settings/flows/ios/TC-0001.yaml",
      "apps/settings/flows/ios/common/launch-clean.yaml",
      "apps/settings/testcases/TC-0001.md",
      "workspace.yaml",
    ]);
    expect(git(c.dir, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("거절한 zip 은 디스크에 아무것도 쓰지 않는다", async () => {
    const d = localFixture("rejected");
    await d.ws.status();
    const head = git(d.dir, "rev-parse", "HEAD");
    const tree = files(d.dir);
    writeFileSync(join(dir, "bad.zip"), buildZip([{ name: "workspace.yaml", data: "schemaVersion: 2\nname: x\napps: [x]\n" }, { name: "apps/x/app.yaml", data: "/etc/passwd", method: 0, mode: 0o120777 }, { name: "apps/x/../../escape.txt", data: "x" }]));
    d.picks.file = join(dir, "bad.zip");
    const r = await d.ws.importPick("file");
    expect(r).toEqual({
      status: "rejected",
      sourceLabel: "bad.zip",
      problems: expect.arrayContaining([expect.objectContaining({ path: "apps/x/app.yaml", code: "link" }), expect.objectContaining({ path: "apps/x/../../escape.txt", code: "path" })]),
    });
    expect(git(d.dir, "rev-parse", "HEAD")).toBe(head);
    expect(files(d.dir)).toEqual(tree);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    // 거절한 뒤에는 쓸 미리보기도 없다
    await expect(d.ws.importApply({ importId: "x", picks: [] })).rejects.toThrow(/미리보기가 없다/);
  });

  it("실행·플로우 만들기 중이거나 미리보기 뒤 워크스페이스가 바뀌었으면 가져오지 않는다", async () => {
    const e = localFixture("busy");
    await seedSettings(e.ws);
    e.picks.file = join(dir, "export.zip");
    const p = preview(await e.ws.importPick("file"));
    expect(p.items.find((i) => i.key === "testcase:settings:TC-0001")?.status).toBe("same");
    e.setBusy("플로우 실행이 진행 중이다");
    await expect(e.ws.importApply({ importId: p.importId, picks: defaults(p) })).rejects.toThrow("플로우 실행이 진행 중이다. 끝난 뒤 가져온다");
    e.setBusy(null);
    await e.ws.saveTestcase({ app: "settings", id: "TC-0002", text: testcaseTemplate({ id: "TC-0002", app: "settings", targets: ["ios"] }), summary: "second" });
    await expect(e.ws.importApply({ importId: p.importId, picks: defaults(p) })).rejects.toThrow(/미리보기를 만든 뒤 워크스페이스가 바뀌었다/);
  });

  it("받는 쪽 서브플로우와 대소문자만 다른 이름은 새 파일을 만들지 않고, 그런 이름을 쓰려 하면 아무것도 바꾸지 않고 거절한다", async () => {
    const f = localFixture("case");
    await seedSettings(f.ws);
    writeFileSync(join(f.dir, "apps/settings/flows/ios/common/Setup.yaml"), "appId: ${APP_ID}\n---\n- hideKeyboard\n");
    git(f.dir, "add", ".");
    git(f.dir, "commit", "-q", "-m", "upper");
    const theirs = "appId: ${APP_ID}\n---\n- launchApp\n";
    writeFileSync(join(dir, "case.zip"), buildZip([{ name: "workspace.yaml", data: "schemaVersion: 2\nname: x\napps: [settings]\n" }, { name: "apps/settings/flows/ios/common/setup.yaml", data: theirs }]));
    f.picks.file = join(dir, "case.zip");
    const p = preview(await f.ws.importPick("file"));
    expect(p.items).toMatchObject([{ key: "subflow:settings:ios:setup.yaml", status: "differs", defaultChoice: "keep-ours" }]);
    await f.ws.importApply({ importId: p.importId, picks: [{ key: "subflow:settings:ios:setup.yaml", action: "take-theirs" }] });
    expect(git(f.dir, "ls-files", "apps/settings/flows/ios/common").split("\n")).toEqual(["apps/settings/flows/ios/common/Setup.yaml", "apps/settings/flows/ios/common/close-keyboard.yaml", "apps/settings/flows/ios/common/dismiss-system-prompts.yaml", "apps/settings/flows/ios/common/launch-clean.yaml"]);
    expect(git(f.dir, "show", "HEAD:apps/settings/flows/ios/common/Setup.yaml")).toBe(theirs.trim());

    // 쓰는 단계도 스스로 막는다: 대소문자만 다른 경로를 넘기면 쓰지 않는다
    const head = git(f.dir, "rev-parse", "HEAD");
    const run = (args: string[], opts?: { raw?: boolean }) => Promise.resolve(opts?.raw ? execFileSync("/usr/bin/git", args, { cwd: f.dir }).toString() : git(f.dir, ...args));
    await expect(
      commitLocalImport({ git: run, files: new Map([["apps/settings/flows/ios/common/SETUP.yaml", new TextEncoder().encode("x")]]), message: "m", author: [], resolve: (rel) => join(f.dir, rel) }),
    ).rejects.toThrow("이미 있는 apps/settings/flows/ios/common/Setup.yaml 와 대소문자만 다른 이름이라 쓰지 않는다");
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.dir, "status", "--porcelain")).toBe("");
    expect(git(f.dir, "show", "HEAD:apps/settings/flows/ios/common/Setup.yaml")).toBe(theirs.trim());
  });

  it("git 이 받지 않는 파일이 있으면 쓴 것을 모두 되돌린다", async () => {
    const g = localFixture("restore");
    await g.ws.status();
    writeFileSync(join(g.dir, ".gitignore"), "*.meta.yaml\n");
    git(g.dir, "add", ".gitignore");
    git(g.dir, "commit", "-q", "-m", "ignore");
    const tree = files(g.dir);
    g.picks.file = join(dir, "export.zip");
    const p = preview(await g.ws.importPick("file"));
    await expect(g.ws.importApply({ importId: p.importId, picks: defaults(p) })).rejects.toThrow(/git add 실패/);
    expect(files(g.dir)).toEqual(tree);
    expect(existsSync(join(g.dir, "apps"))).toBe(false);
    expect(git(g.dir, "status", "--porcelain")).toBe("");
  });

  it("폴더는 링크를 따라가지 않고 읽고, 그 폴더에서 git 을 실행하지 않는다(core.fsmonitor 가 있어도)", async () => {
    const h = localFixture("folder");
    await h.ws.status();
    const folder = join(dir, "picked-folder");
    cpSync(join(localFixture("roundtrip-a").dir), folder, { recursive: true });
    const marker = join(dir, "fsmonitor-ran");
    git(folder, "config", "core.fsmonitor", `touch ${marker}`);
    h.picks.folder = folder;
    const p = preview(await h.ws.importPick("folder"));
    expect(p.sourceLabel).toBe("picked-folder");
    expect(p.items.map((i) => i.key)).toContain("testcase:settings:TC-0001");
    expect(p.skipped.some((s) => s.path.startsWith(".git"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    symlinkSync("/etc/hosts", join(folder, "apps/settings/hosts.yaml"));
    expect(await h.ws.importPick("folder")).toMatchObject({ status: "rejected", problems: [{ path: "apps/settings/hosts.yaml", code: "link" }] });
    expect(existsSync(marker)).toBe(false);
  });

  it("로컬 워크스페이스에서 '이 Mac 의 로컬 워크스페이스' 가져오기는 고를 수 없다. 앱이 없는 워크스페이스도 내보낸다", async () => {
    const i = localFixture("self");
    await i.ws.status();
    await expect(i.ws.importPick("local-workspace")).rejects.toThrow(/GitHub 사용을 켠 워크스페이스에서만/);
    expect(await i.ws.exportInfo()).toMatchObject({ apps: 0, testcases: 0, flows: 0, subflows: 0, appNames: [], testcaseIds: [] });
    i.picks.save = join(dir, "empty.zip");
    await i.ws.exportZip();
    const zip = readZip(readFileSync(join(dir, "empty.zip")));
    expect(zip.ok && [...zip.files.keys()]).toEqual(["workspace.yaml"]);
    // 저장 창을 닫으면 아무것도 쓰지 않는다
    i.picks.save = undefined;
    expect(await i.ws.exportZip()).toBeNull();
    i.picks.file = undefined;
    expect(await i.ws.importPick("file")).toEqual({ status: "canceled" });
  });
});

describe("GitHub 방식 가져오기·내보내기", { timeout: 90_000 }, () => {
  let bare: string;
  let fake: FakeGitHub;
  let server: Awaited<ReturnType<typeof startGitHttp>>;
  let askpass: AskpassServer;
  let ws: WorkspaceService;
  let local: ReturnType<typeof localFixture>;
  const picks: Picks = {};
  const wsDir = () => join(dir, "gh", "workspaces", "qa-workspace");

  beforeAll(async () => {
    const seed = join(dir, "gh-seed");
    cpSync(EXAMPLE, seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "template");
    bare = join(dir, "gh-srv", "acme", "qa-workspace.git");
    mkdirSync(join(dir, "gh-srv", "acme"), { recursive: true });
    git(dir, "clone", "-q", "--bare", seed, bare);
    git(bare, "config", "http.receivepack", "true");
    server = await startGitHttp({ root: join(dir, "gh-srv"), password: TOKEN });
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-workspace": { push: true } } });
    askpass = await AskpassServer.start();
    // 이 Mac 의 로컬 워크스페이스: 같은 앱 데이터의 local-workspace(로컬 방식으로 채운다)
    local = localFixture("gh");
    await seedSettings(local.ws);
    // 예시 워크스페이스의 sample/TC-0002 와 번호가 겹치는 로컬 테스트 케이스
    await local.ws.saveTestcase({ app: "settings", id: "TC-0002", text: testcaseTemplate({ id: "TC-0002", app: "settings", targets: ["ios"] }), summary: "second" });
    await local.ws.saveFlow({ id: "TC-0002", flowPath: "apps/settings/flows/ios/TC-0002.yaml", metaPath: "apps/settings/flows/ios/TC-0002.meta.yaml", yaml: FLOW("TC-0002"), meta: META("TC-0002"), summary: "flow" });
    const source: WorkspaceSourceKind = "github";
    ws = new WorkspaceService({
      root: join(dir, "gh", "workspaces"),
      source: () => source,
      saveSource: () => undefined,
      localDir: local.dir,
      localAuthor: AUTHOR,
      remote: new GitHubProvider({ token: () => TOKEN, apiUrl: fake.url, webUrl: server.url }),
      github: () => ({ owner: "acme", workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-", evidenceRepo: null, evidenceOwner: null }),
      token: () => TOKEN,
      askpass: () => Promise.resolve(askpass),
      home,
      busy: () => null,
      checkFlowSyntax,
      openFolder: () => Promise.reject(new Error("열지 않는다")),
      pickImport: (from) => Promise.resolve((from === "file" ? picks.file : picks.folder) ?? null),
      pickExportPath: () => Promise.resolve(picks.save ?? null),
    });
    await ws.connect();
  });
  afterAll(async () => {
    await server.close();
    await fake.close();
    await askpass.close();
  });

  it("작업 브랜치에 있어도 main 의 내용을 내보낸다. CODEOWNERS·PR 템플릿·README 와 계정 값은 없다", async () => {
    const { text } = ws.readTestcase("demo", "TC-0101");
    await ws.saveTestcase({ app: "demo", id: "TC-0101", text: text.replace("홈 화면이 열리고", "홈(편집)이 열리고"), summary: "edit" });
    expect((await ws.status()).onMain).toBe(false);
    expect(await ws.exportInfo()).toMatchObject({ ref: "main", apps: 2, testcases: 2, appNames: ["Demo", "Sample"], testcaseIds: ["TC-0002", "TC-0101"] });
    picks.save = join(dir, "gh-export.zip");
    await ws.exportZip();
    const zip = readZip(readFileSync(join(dir, "gh-export.zip")));
    if (!zip.ok) throw new Error("zip");
    // main 이 추적하는 workspace.yaml 과 apps/ 의 파일만 있다(계정 값은 저장소에 없다)
    expect([...zip.files.keys()].sort()).toEqual(git(wsDir(), "ls-tree", "-r", "--name-only", "main", "--", "workspace.yaml", "apps").split("\n").sort());
    expect([...zip.files.keys()].filter((p) => !p.startsWith("apps/"))).toEqual(["workspace.yaml"]);
    expect(git(wsDir(), "ls-tree", "--name-only", "main")).toContain("CODEOWNERS");
    expect(new TextDecoder().decode(zip.files.get("apps/demo/testcases/TC-0101.md"))).toBe(`${git(wsDir(), "show", "main:apps/demo/testcases/TC-0101.md")}\n`);
    git(wsDir(), "checkout", "-q", "main");
  });

  it("GitHub 방식: 앱 설정 PR 이 머지되기 전에는 그 앱·타깃의 테스트 케이스를 저장하지 않고 이유를 알린다. 머지되면 저장된다", async () => {
    const branchesOf = () => git(wsDir(), "branch", "--format=%(refname:short)").split("\n").sort();
    const mainBefore = git(wsDir(), "rev-parse", "main");
    await ws.saveApp({ app: "shop", create: true, name: "Shop", locale: null, targets: [{ target: "ios", appId: "com.example.shop" }], roles: [], summary: "shop app" });
    const appBranch = git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD");
    expect(appBranch).toBe("qa/qa-bot/app/shop/shop-app");
    const before = branchesOf();
    const tc = testcaseTemplate({ id: "TC-0500", app: "shop", targets: ["ios"] });
    // 앱 설정 브랜치에만 있는 새 앱: main 에서 갈라질 테스트 케이스 브랜치에는 앱 설정이 없다
    await expect(ws.saveTestcase({ app: "shop", id: "TC-0500", text: tc, summary: "shop tc" })).rejects.toThrow(
      /shop 앱 설정이 아직 main 에 없다\(qa\/qa-bot\/app\/shop\/shop-app\)\. 앱 설정 PR 을 머지하고 동기화한 뒤 테스트 케이스를 저장한다/,
    );
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(appBranch);
    expect(branchesOf()).toEqual(before);
    expect(git(wsDir(), "status", "--porcelain")).toBe("");

    // 앱 설정 브랜치에서만 더한 타깃도 같다
    git(wsDir(), "checkout", "-q", "main");
    const demo = await ws.readApp("demo");
    await ws.saveApp({ app: "demo", create: false, name: demo.name, locale: demo.locale, targets: [...demo.targets.map((t) => ({ target: t.target, appId: t.appId })), { target: "android", appId: "com.example.demo" }], roles: demo.roles, summary: "demo android" });
    const demoBranch = git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD");
    const androidTc = testcaseTemplate({ id: "TC-0501", app: "demo", targets: ["android"] });
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0501", text: androidTc, summary: "demo android tc" })).rejects.toThrow(
      new RegExp(`demo 의 android 타깃이 아직 main 의 앱 설정에 없다\\(${demoBranch.replace(/\//g, "\\/")}\\)\\. 앱 설정 PR 을 머지하고 동기화한 뒤 테스트 케이스를 저장한다`),
    );
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(demoBranch);

    // 앱 설정 PR 이 머지되면(main 에 들어오면) 테스트 케이스 브랜치에 앱 설정이 있고 플로우 만들기 준비가 된다
    git(wsDir(), "checkout", "-q", "main");
    git(wsDir(), "merge", "-q", "--no-ff", "-m", "merge shop", appBranch);
    const saved = await ws.saveTestcase({ app: "shop", id: "TC-0500", text: tc, summary: "shop tc" });
    expect(saved.branch).toBe("qa/qa-bot/TC-0500-shop-tc");
    expect(git(wsDir(), "ls-tree", "-r", "--name-only", "HEAD", "--", "apps/shop").split("\n")).toContain("apps/shop/app.yaml");
    await expect(ws.authorContext("shop", "TC-0500", "ios")).resolves.toMatchObject({ flowPath: "apps/shop/flows/ios/TC-0500.yaml" });

    // 다음 시험을 위해 되돌린다(main 과 브랜치)
    git(wsDir(), "checkout", "-q", "main");
    git(wsDir(), "reset", "-q", "--hard", mainBefore);
    for (const b of [saved.branch, appBranch, demoBranch]) git(wsDir(), "branch", "-q", "-D", b);
  });

  it("이 Mac 의 로컬 워크스페이스를 가져오면 새 가져오기 브랜치에 한 커밋이 생기고 작업 폴더와 main 은 그대로다. 그 브랜치로 PR 을 만든다", async () => {
    git(wsDir(), "checkout", "-q", "qa/qa-bot/TC-0101-edit");
    const head = git(wsDir(), "rev-parse", "HEAD");
    const main = git(wsDir(), "rev-parse", "main");
    const tree = files(wsDir()).map((p) => `${p}:${statSync(join(wsDir(), p)).mtimeMs}`);
    const p = preview(await ws.importPick("local-workspace"));
    expect(p.sourceLabel).toBe("이 Mac 의 로컬 워크스페이스");
    expect(p.items.map((i) => [i.key, i.status, i.label])).toEqual([
      ["app:settings", "new", "앱 설정 · Settings"],
      ["testcase:settings:TC-0001", "new", expect.stringMatching(/^TC-0001 /)],
      ["testcase:settings:TC-0002", "renumber", expect.stringMatching(/^TC-0002 → TC-0102 /)],
      ["subflow:settings:ios:close-keyboard.yaml", "new", "공통 서브플로우 · close-keyboard.yaml"],
      ["subflow:settings:ios:dismiss-system-prompts.yaml", "new", "공통 서브플로우 · dismiss-system-prompts.yaml"],
      ["subflow:settings:ios:launch-clean.yaml", "new", "공통 서브플로우 · launch-clean.yaml"],
    ]);
    const r = await ws.importApply({ importId: p.importId, picks: defaults(p) });
    expect(r).toEqual({ source: "github", branch: "qa/qa-bot/import/settings", commit: expect.stringMatching(/^[0-9a-f]{7,}$/), renumbered: [{ from: "TC-0002", to: "TC-0102" }] });
    expect(git(wsDir(), "rev-parse", "HEAD")).toBe(head);
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("qa/qa-bot/TC-0101-edit");
    expect(git(wsDir(), "rev-parse", "main")).toBe(main);
    expect(git(wsDir(), "status", "--porcelain")).toBe("");
    expect(files(wsDir()).map((x) => `${x}:${statSync(join(wsDir(), x)).mtimeMs}`)).toEqual(tree);
    expect(git(wsDir(), "rev-list", "--count", "main..qa/qa-bot/import/settings")).toBe("1");
    expect(git(wsDir(), "rev-parse", "qa/qa-bot/import/settings^")).toBe(main);
    expect(committed(wsDir(), "qa/qa-bot/import/settings")).toEqual([
      "apps/settings/app.yaml",
      "apps/settings/flows/ios/TC-0001.meta.yaml",
      "apps/settings/flows/ios/TC-0001.yaml",
      "apps/settings/flows/ios/TC-0102.meta.yaml",
      "apps/settings/flows/ios/TC-0102.yaml",
      "apps/settings/flows/ios/common/close-keyboard.yaml",
      "apps/settings/flows/ios/common/dismiss-system-prompts.yaml",
      "apps/settings/flows/ios/common/launch-clean.yaml",
      "apps/settings/testcases/TC-0001.md",
      "apps/settings/testcases/TC-0102.md",
      "workspace.yaml",
    ]);
    expect(git(wsDir(), "show", "qa/qa-bot/import/settings:apps/settings/flows/ios/TC-0102.yaml")).toBe(FLOW("TC-0102").trim());
    expect(git(wsDir(), "show", "qa/qa-bot/import/settings:apps/settings/flows/ios/TC-0102.meta.yaml")).toBe(META("TC-0102").trim());
    expect(git(wsDir(), "log", "-1", "--format=%an|%ae", "qa/qa-bot/import/settings")).toBe("qa-bot|qa-bot@users.noreply.github.com");

    const listed = (await ws.branches()).branches.find((b) => b.name === "qa/qa-bot/import/settings");
    expect(listed).toMatchObject({ tcId: null, appSettings: null, current: false, ahead: 1, pending: true });
    const pr = await ws.requestReview({ title: "로컬 워크스페이스에서 가져온다", body: "settings", branch: "qa/qa-bot/import/settings" });
    expect(pr).toMatchObject({ branch: "qa/qa-bot/import/settings", existing: false });
    expect(fake.pulls.at(-1)).toEqual({ repo: "acme/qa-workspace", head: "qa/qa-bot/import/settings", base: "main", title: "로컬 워크스페이스에서 가져온다", body: "settings" });
    expect(git(bare, "rev-parse", "qa/qa-bot/import/settings")).toBe(git(wsDir(), "rev-parse", "qa/qa-bot/import/settings"));
    expect(git(wsDir(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("qa/qa-bot/TC-0101-edit");
  });

  it("가져오기 브랜치는 브랜치마다 따로인 작업 범위다", () => {
    expect(workBranchScope("qa/qa-bot/import/settings", "qa-bot")).toBe("import/settings");
    expect(workBranchScope("qa/qa-bot/import/settings-2", "qa-bot")).toBe("import/settings-2");
    expect(workBranchScope("qa/other/import/settings", "qa-bot")).toBeNull();
  });

  it("두 번 가져오면 브랜치가 둘이다", async () => {
    const p = preview(await ws.importPick("local-workspace"));
    const r = await ws.importApply({ importId: p.importId, picks: defaults(p) });
    expect(r).toMatchObject({ source: "github", branch: "qa/qa-bot/import/settings-2" });
    expect((await ws.branches()).branches.map((b) => b.name).filter((n) => n.includes("/import/")).sort()).toEqual(["qa/qa-bot/import/settings", "qa/qa-bot/import/settings-2"]);
  });

  it("가져오기 PR 이 머지되기 전에는 가져온 테스트 케이스·서브플로우·앱 설정을 고치지 않는다", async () => {
    // 이미 있는 테스트 케이스를 덮어쓰는 가져오기: main 에서 보이는 그 테스트 케이스가 잠긴다
    const edited = ws.readTestcase("demo", "TC-0101").text;
    git(wsDir(), "checkout", "-q", "main");
    const mainText = ws.readTestcase("demo", "TC-0101").text;
    expect(edited).not.toBe(mainText);
    const folder = join(dir, "gh-overwrite");
    mkdirSync(join(folder, "apps/demo/testcases"), { recursive: true });
    writeFileSync(join(folder, "workspace.yaml"), "schemaVersion: 2\nname: x\napps: [demo]\n");
    writeFileSync(join(folder, "apps/demo/testcases/TC-0101.md"), mainText.replace("이메일로 계속하기", "이메일로 시작하기"));
    picks.folder = folder;
    const p = preview(await ws.importPick("folder"));
    expect(p.items).toMatchObject([{ key: "testcase:demo:TC-0101", status: "differs", defaultChoice: null }]);
    const r = await ws.importApply({ importId: p.importId, picks: [{ key: "testcase:demo:TC-0101", action: "overwrite" }] });
    expect(r).toMatchObject({ branch: "qa/qa-bot/import/demo" });

    const list = await ws.testcases();
    expect(list.testcases.find((t) => t.id === "TC-0101")?.lockedBy).toEqual({ branch: "qa/qa-bot/import/demo" });
    expect(list.testcases.find((t) => t.id === "TC-0002")?.lockedBy).toBeNull();
    const refusal = /가져오기 PR 을 머지하고 동기화한 뒤 고친다/;
    await expect(ws.saveTestcase({ app: "demo", id: "TC-0101", text: mainText.replace("홈 화면이 열리고", "홈이 열리고"), summary: "locked" })).rejects.toThrow(refusal);
    await expect(ws.useTestcaseBranch("TC-0101")).rejects.toThrow(refusal);
    await expect(ws.saveFlow({ id: "TC-0101", flowPath: "apps/demo/flows/ios/TC-0101.yaml", metaPath: "apps/demo/flows/ios/TC-0101.meta.yaml", yaml: FLOW("TC-0101"), meta: META("TC-0101"), summary: "x" })).rejects.toThrow(refusal);
    // 다른 테스트 케이스는 그대로 고칠 수 있다
    expect(await ws.useTestcaseBranch("TC-0002")).toBe("main");

    // 새로 가져온 앱의 서브플로우·앱 설정: 가져오기 브랜치를 꺼내 보면 잠겨 있다
    git(wsDir(), "checkout", "-q", "qa/qa-bot/import/settings");
    expect((await ws.testcases()).testcases.find((t) => t.id === "TC-0102")?.lockedBy).toEqual({ branch: "qa/qa-bot/import/settings" });
    await expect(ws.saveSubflow({ app: "settings", target: "ios", name: "launch-clean.yaml", text: "appId: ${APP_ID}\n---\n- launchApp\n", summary: "x" })).rejects.toThrow(refusal);
    await expect(ws.saveApp({ app: "settings", create: false, name: "Settings 2", locale: null, targets: [{ target: "ios", appId: "com.apple.Preferences" }], roles: [], summary: "x" })).rejects.toThrow(refusal);
    git(wsDir(), "checkout", "-q", "main");
    expect(git(wsDir(), "status", "--porcelain")).toBe("");
  });

  it("main 이 원격보다 뒤처져 있으면 가져오지 않는다", async () => {
    const other = join(dir, "gh-other");
    git(dir, "clone", "-q", bare, other);
    writeFileSync(join(other, "README.md"), "# 바뀜\n");
    git(other, "commit", "-q", "-am", "readme");
    git(other, "push", "-q", "origin", "main");
    git(wsDir(), "checkout", "-q", "qa/qa-bot/TC-0101-edit");
    await ws.sync();
    await expect(ws.importPick("local-workspace")).rejects.toThrow("main 이 원격보다 1개 뒤처져 있다. main 으로 옮겨 동기화한 뒤 가져온다");
  });
});
