import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { testcaseTemplate } from "../../../packages/workspace/src/model";
import { buildZip } from "../../../packages/workspace/src/testing/zip-builder";
import { buildFakeToolArchives, fakeToolDefinitions, serveFiles, type FakeArchives, type FileServer } from "../test-support/fake-tools";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

// 워크스페이스 내보내기·가져오기(T-127, ADR 0036 결정 11). 가져올 때 플로우마다 Maestro 문법 검사를 하므로 가짜 JRE·Maestro 를 설치해 둔다
const TOKEN = "github_pat_E2ETRANSFER_0123456789abcdefghijklm";
const FLOW = ["appId: ${APP_ID}", "name: TC-0001 설정 첫 화면", "tags: [TC-0001]", "---", "- runFlow: common/launch-clean.yaml", '- assertVisible: "일반"', ""].join("\n");
let archives: FakeArchives;
let server: FileServer;
let toolsFile: string;
let work: string;
test.beforeAll(async () => {
  archives = buildFakeToolArchives();
  server = await serveFiles({ "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro });
  toolsFile = join(archives.dir, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(fakeToolDefinitions(server.url, archives)));
  work = mkdtempSync(join(tmpdir(), "qa-e2e-transfer-"));
});
test.afterAll(async () => {
  await server.close();
  rmSync(archives.dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const files = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((p) => statSync(join(root, p)).isFile())
    .map((p) => relative(root, join(root, p)))
    .sort();

async function installTools(page: Page) {
  await page.evaluate(async () => {
    await window.qa.setup.installTool({ tool: "jre" });
    await window.qa.setup.installTool({ tool: "maestro" });
  });
}

/** 설정 앱과 TC-0001·플로우를 넣은 로컬 워크스페이스(준비는 IPC 와 파일로, 증명은 화면으로) */
async function seedLocal(page: Page, localDir: string) {
  await page.evaluate(() =>
    window.qa.workspace.saveApp({ app: "settings", create: true, name: "Settings", locale: null, targets: [{ target: "ios", appId: "com.apple.Preferences" }], roles: [], summary: "settings app" }),
  );
  const text = testcaseTemplate({ id: "TC-0001", app: "settings", targets: ["ios"] }).replace("무엇을 확인하는지 한 줄로 쓴다", "설정 앱을 열면 첫 화면이 보인다");
  await page.evaluate((tc) => window.qa.workspace.saveTestcase({ app: "settings", id: "TC-0001", text: tc, summary: "first" }), text);
  mkdirSync(join(localDir, "apps/settings/flows/ios"), { recursive: true });
  writeFileSync(join(localDir, "apps/settings/flows/ios/TC-0001.yaml"), FLOW);
  execFileSync("/usr/bin/git", ["-c", "user.name=e2e", "-c", "user.email=e2e@avocado.local", "add", "--", "apps"], { cwd: localDir });
  execFileSync("/usr/bin/git", ["-c", "user.name=e2e", "-c", "user.email=e2e@avocado.local", "commit", "--quiet", "-m", "flow: TC-0001"], { cwd: localDir });
}

function stubSaveDialog(app: ElectronApplication, path: string) {
  return app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked });
  }, path);
}
function stubOpenDialog(app: ElectronApplication, path: string) {
  return app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}

async function openTransfer(page: Page) {
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "워크스페이스", exact: true }).click();
  await page.getByTestId("ws-nav-transfer").click();
  return page.getByTestId("transfer");
}

test("로컬: 내보낸 zip 을 새 앱 데이터의 로컬 워크스페이스에 가져오면 실행 화면에 테스트 케이스가 보인다. GitHub 에 닿지 않는다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const zip = join(work, "settings.zip");
  try {
    const a = await launchApp({ workspaceSource: "local", env: remote.env });
    await seedLocal(a.page, join(a.userDataDir, "local-workspace"));
    const panel = await openTransfer(a.page);
    await expect(panel.getByRole("heading", { name: "내보내기" })).toBeVisible();
    await expect(panel.getByTestId("export-includes")).toContainText("Settings 의 app.yaml 과 accounts.yaml");
    await expect(panel.getByTestId("export-includes")).toContainText("TC-0001");
    await stubSaveDialog(a.app, zip);
    await panel.getByRole("button", { name: "zip 으로 저장…" }).click();
    await expect(panel.getByTestId("export-saved")).toContainText("settings.zip");
    expect(existsSync(zip)).toBe(true);
    await a.app.close();

    const b = await launchApp({ workspaceSource: "local", env: remote.env, toolsFile });
    await installTools(b.page);
    const importPanel = await openTransfer(b.page);
    await importPanel.getByRole("tab", { name: "가져오기" }).click();
    await stubOpenDialog(b.app, zip);
    await importPanel.getByRole("button", { name: "zip 고르기…" }).click();
    const previewPane = importPanel.getByTestId("import-preview");
    await expect(previewPane).toContainText("settings.zip");
    await expect(previewPane.getByTestId("import-row-testcase:settings:TC-0001")).toContainText("새로 생김");
    await expect(previewPane.getByRole("checkbox", { name: "TC-0001 설정 앱을 열면 첫 화면이 보인다 가져오기" })).toBeChecked();
    await importPanel.getByRole("button", { name: "고른 항목 5개 가져오기" }).click();
    await expect(importPanel.getByTestId("import-done")).toContainText("로컬 워크스페이스에 가져왔습니다");

    await b.page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "실행", exact: true }).click();
    const setup = b.page.getByTestId("run-setup");
    await setup.getByRole("tab", { name: "테스트 케이스" }).click();
    await setup.getByLabel("실행할 앱").selectOption("settings");
    await setup.getByLabel("실행 타깃").selectOption("ios");
    await expect(setup.getByLabel("실행할 테스트 케이스").locator("option", { hasText: "TC-0001" })).toHaveCount(1);
    await b.app.close();

    expect(remote.api.requests).toEqual([]);
    expect(remote.gitServer.seen).toEqual({ authorized: 0, rejected: 0 });
  } finally {
    await remote.close();
  }
});

test("로컬: 링크·밖을 가리키는 이름이 든 zip 은 전체를 거절하고 디스크에 아무것도 쓰지 않는다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const zip = join(work, "bad.zip");
  writeFileSync(
    zip,
    buildZip([
      { name: "workspace.yaml", data: "schemaVersion: 2\nname: x\napps: [demo]\n" },
      { name: "apps/demo/app.yaml", data: "/etc/passwd", method: 0, mode: 0o120777 },
      { name: "apps/demo/../../escape.txt", data: "x" },
      { name: "Apps/Demo/testcases/TC-0002.md", data: "a" },
      { name: "apps/demo/testcases/TC-0002.md", data: "b" },
    ]),
  );
  try {
    const { app, page, userDataDir } = await launchApp({ workspaceSource: "local", env: remote.env });
    const localDir = join(userDataDir, "local-workspace");
    await page.evaluate(() => window.qa.workspace.status());
    const before = { head: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: localDir }).toString(), files: files(localDir) };
    const panel = await openTransfer(page);
    await panel.getByRole("tab", { name: "가져오기" }).click();
    await stubOpenDialog(app, zip);
    await panel.getByRole("button", { name: "zip 고르기…" }).click();
    const rejected = panel.getByTestId("import-rejected");
    await expect(rejected).toContainText("bad.zip 은 가져오지 않았습니다");
    await expect(rejected).toContainText("이 Mac 에는 아무것도 쓰지 않았습니다");
    await expect(rejected.getByRole("listitem").filter({ hasText: "apps/demo/app.yaml" })).toContainText("링크");
    await expect(rejected.getByRole("listitem").filter({ hasText: "escape.txt" })).toContainText("경로");
    await expect(rejected.getByRole("listitem").filter({ hasText: "Apps/Demo/testcases/TC-0002.md" })).toContainText("이름 겹침");
    await expect(panel.getByRole("button", { name: "다른 파일 고르기" })).toBeVisible();
    expect({ head: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: localDir }).toString(), files: files(localDir) }).toEqual(before);
    expect(existsSync(join(userDataDir, "escape.txt"))).toBe(false);
    await app.close();
    expect(remote.api.requests).toEqual([]);
  } finally {
    await remote.close();
  }
});

test("GitHub 방식: 이 Mac 의 로컬 워크스페이스를 가져와 가져오기 브랜치에 커밋하고 PR 을 한 건 만든다. 작업 폴더의 브랜치는 그대로다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page, userDataDir } = await launchApp({ workspaceSource: "local", env: remote.env, toolsFile });
    await installTools(page);
    await seedLocal(page, join(userDataDir, "local-workspace"));
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.setSource({ source: "github" }));
    await page.evaluate(() => window.qa.workspace.connect());
    const wsDir = join(userDataDir, "workspaces", "qa-workspace");
    const head = () => execFileSync("/usr/bin/git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wsDir }).toString().trim();
    expect(head()).toBe("main");

    const panel = await openTransfer(page);
    await panel.getByRole("tab", { name: "가져오기" }).click();
    await expect(panel.getByRole("combobox", { name: "가져올 곳" })).toHaveValue("local-workspace");
    await panel.getByRole("button", { name: "견주어 보기" }).click();
    const previewPane = panel.getByTestId("import-preview");
    await expect(previewPane).toContainText("이 Mac 의 로컬 워크스페이스");
    await expect(previewPane.getByTestId("import-row-app:settings")).toContainText("새로 생김");
    await panel.getByRole("button", { name: "고른 항목 5개 가져오기" }).click();
    const done = panel.getByTestId("import-done");
    await expect(done).toContainText("가져오기 브랜치에 커밋했습니다");
    await expect(done).toContainText("qa/qa-bot/import/settings");
    expect(head()).toBe("main");
    expect(execFileSync("/usr/bin/git", ["status", "--porcelain"], { cwd: wsDir }).toString()).toBe("");
    expect(remote.api.pulls).toEqual([]);

    await expect(done.getByLabel("제목")).toHaveValue("로컬 워크스페이스에서 settings 앱과 테스트 케이스 1개를 가져온다");
    await panel.getByRole("button", { name: "PR 작성" }).click();
    await expect(panel.getByTestId("import-pr")).toContainText("PR #");
    expect(remote.api.pulls).toHaveLength(1);
    expect(remote.api.pulls[0]).toMatchObject({ repo: "acme/qa-workspace", head: "qa/qa-bot/import/settings", base: "main" });
    expect(remote.git(remote.bare, "show", "qa/qa-bot/import/settings:apps/settings/flows/ios/TC-0001.yaml")).toBe(FLOW.trim());
    expect(head()).toBe("main");

    // Git 상태 인스펙터에는 "가져오기"로 보인다
    expect((await page.evaluate(() => window.qa.workspace.branches())).branches.map((b) => b.name)).toContain("qa/qa-bot/import/settings");
    await app.close();
  } finally {
    await remote.close();
  }
});
