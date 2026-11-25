import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testcaseTemplate } from "../../../packages/workspace/src/model";
import { buildZip } from "../../../packages/workspace/src/testing/zip-builder";
import { buildFakeToolArchives, fakeToolDefinitions, serveFiles } from "../test-support/fake-tools";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

// 워크스페이스 내보내기·가져오기 화면(T-127, ADR 0036 결정 11): 내보내기, 상태가 섞인 미리보기(비교 보기·고르기), 거절, GitHub 방식의 결과와 PR, 잠긴 테스트 케이스.
// 가짜 원격·가짜 Maestro 로 돈다(기기 없음). 파일 선택 창만 바꿔 끼운다
const TOKEN = "github_pat_VERIFYTRANSFER_0123456789abcdefgh";
const flow = (id: string, extra: string[] = []) => ["appId: ${APP_ID}", `name: ${id} 첫 화면`, `tags: [${id}]`, "---", "- runFlow: common/launch-clean.yaml", ...extra, '- assertVisible: "일반"', ""].join("\n");
const tc = (id: string, app: string, title: string) => testcaseTemplate({ id, app, targets: ["ios"] }).replace("무엇을 확인하는지 한 줄로 쓴다", title);

function stubDialogs(app: ElectronApplication, open: string, save: string) {
  return app.evaluate(
    ({ dialog }, paths) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [paths.open] });
      (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: paths.save });
    },
    { open, save },
  );
}

async function seed(page: Page, localDir: string) {
  await page.evaluate(() => window.qa.workspace.saveApp({ app: "settings", create: true, name: "설정", locale: null, targets: [{ target: "ios", appId: "com.apple.Preferences" }], roles: [], summary: "settings" }));
  await page.evaluate((text) => window.qa.workspace.saveTestcase({ app: "settings", id: "TC-0001", text, summary: "first" }), tc("TC-0001", "settings", "설정 앱을 열면 첫 화면이 보인다"));
  mkdirSync(join(localDir, "apps/settings/flows/ios"), { recursive: true });
  writeFileSync(join(localDir, "apps/settings/flows/ios/TC-0001.yaml"), flow("TC-0001"));
  execFileSync("/usr/bin/git", ["-c", "user.name=v", "-c", "user.email=v@avocado.local", "add", "--", "apps"], { cwd: localDir });
  execFileSync("/usr/bin/git", ["-c", "user.name=v", "-c", "user.email=v@avocado.local", "commit", "--quiet", "-m", "flow"], { cwd: localDir });
}

test("내보내기·가져오기 화면", async () => {
  test.setTimeout(10 * 60_000);
  const archives = buildFakeToolArchives();
  const server = await serveFiles({ "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro });
  const toolsFile = join(archives.dir, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(fakeToolDefinitions(server.url, archives)));
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const work = mkdtempSync(join(tmpdir(), "qa-verify-transfer-"));
  const run = await startRun("transfer", { workspaceSource: "local", env: remote.env, toolsFile });
  const { app, page, userDataDir } = run;
  const nav = page.getByRole("navigation", { name: "주 메뉴" });
  const localDir = join(userDataDir, "local-workspace");
  try {
    run.note("doctor", await doctor(run));
    await page.evaluate(async () => {
      await window.qa.setup.installTool({ tool: "jre" });
      await window.qa.setup.installTool({ tool: "maestro" });
    });
    await seed(page, localDir);
    const common = (name: string) => readFileSync(join(localDir, "apps/settings/flows/ios/common", name), "utf8");
    const settingsSubflows = { launch: common("launch-clean.yaml"), dismiss: common("dismiss-system-prompts.yaml"), close: common("close-keyboard.yaml") };

    // 내보내기
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByTestId("ws-nav-transfer").click();
    const panel = page.getByTestId("transfer");
    await expect(panel.getByTestId("export-includes")).toContainText("TC-0001");
    await run.shot("export");
    await stubDialogs(app, join(work, "unused.zip"), join(work, "export.zip"));
    await panel.getByRole("button", { name: "zip 으로 저장…" }).click();
    await expect(panel.getByTestId("export-saved")).toBeVisible();
    await run.shot("export-saved");

    // 상태가 섞인 zip: 새 앱(번호가 겹치는 TC 포함), 내용이 다른 TC·서브플로우, 같은 서브플로우, 받지 않는 TC, 건너뛸 파일
    const mixed = join(work, "notes-from-jiwon.zip");
    writeFileSync(
      mixed,
      buildZip([
        { name: "workspace.yaml", data: "schemaVersion: 2\nname: jiwon\napps: [notes, settings]\n" },
        { name: "README.md", data: "# 지원의 워크스페이스\n" },
        { name: "apps/notes/app.yaml", data: "name: Notes\ntargets:\n  ios:\n    appId: com.example.notes\n" },
        { name: "apps/notes/testcases/TC-0001.md", data: tc("TC-0001", "notes", "새 메모를 만든다") },
        { name: "apps/notes/flows/ios/TC-0001.yaml", data: flow("TC-0001") },
        { name: "apps/notes/testcases/TC-0002.md", data: tc("TC-0002", "notes", "메모를 지운다") },
        { name: "apps/notes/flows/ios/TC-0002.yaml", data: flow("TC-0002") },
        { name: "apps/notes/flows/ios/TC-0003.yml", data: flow("TC-0003") },
        { name: "apps/notes/flows/ios/common/launch-clean.yaml", data: settingsSubflows.launch },
        { name: "apps/settings/testcases/TC-0001.md", data: tc("TC-0001", "settings", "설정 앱을 열면 첫 화면이 보인다").replace("'버튼 이름'을 탭한다", "'일반'을 탭한다") },
        { name: "apps/settings/flows/ios/TC-0001.yaml", data: flow("TC-0001", ['- tapOn: "일반"']) },
        { name: "apps/settings/flows/ios/common/dismiss-system-prompts.yaml", data: `${settingsSubflows.dismiss}- tapOn:\n    text: "확인"\n    optional: true\n` },
        { name: "apps/settings/flows/ios/common/close-keyboard.yaml", data: settingsSubflows.close },
        { name: "apps/settings/testcases/TC-0003.md", data: tc("TC-0003", "settings", "다른 앱을 띄운다") },
        { name: "apps/settings/flows/ios/TC-0003.yaml", data: flow("TC-0003", ["- launchApp:", "    appId: com.apple.mobilesafari"]) },
      ]),
    );
    await panel.getByRole("tab", { name: "가져오기" }).click();
    await run.shot("import-idle");
    await stubDialogs(app, mixed, join(work, "unused.zip"));
    await panel.getByRole("button", { name: "zip 고르기…" }).click();
    const preview = panel.getByTestId("import-preview");
    await expect(preview).toContainText("notes-from-jiwon.zip");
    await run.shot("import-preview");
    await preview.getByTestId("import-row-testcase:settings:TC-0001").getByRole("button", { name: "비교 보기" }).click();
    await expect(preview.getByRole("figure", { name: "apps/settings/testcases/TC-0001.md 비교" })).toBeVisible();
    await panel.getByTestId("import-skipped").locator("summary").click();
    await run.shot("import-preview-compare");
    run.note("preview-rows", await preview.locator("tbody tr[data-testid]").allInnerTexts());
    await panel.getByRole("button", { name: /^고른 항목 \d+개 가져오기$/ }).click();
    await expect(panel.getByTestId("import-done")).toBeVisible();
    await run.shot("import-done-local");
    run.note("local-log", execFileSync("/usr/bin/git", ["log", "--format=%h %an %s", "-3"], { cwd: localDir }).toString());

    // 거절
    const bad = join(work, "shared-tests.zip");
    writeFileSync(
      bad,
      buildZip([
        { name: "workspace.yaml", data: "schemaVersion: 2\nname: x\napps: [demo]\n" },
        { name: "apps/demo/app.yaml", data: "/etc/passwd", method: 0, mode: 0o120777 },
        { name: "Apps/Demo/testcases/TC-0002.md", data: "a" },
        { name: "apps/demo/testcases/TC-0002.md", data: "b" },
        { name: "apps/demo/../../escape.txt", data: "x" },
      ]),
    );
    await page.getByRole("button", { name: "다른 것 가져오기" }).click();
    await stubDialogs(app, bad, join(work, "unused.zip"));
    await panel.getByRole("button", { name: "zip 고르기…" }).click();
    await expect(panel.getByTestId("import-rejected")).toBeVisible();
    await run.shot("import-rejected");

    // GitHub 방식: 로컬 워크스페이스 가져오기 → 결과와 PR → 잠긴 테스트 케이스
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.setSource({ source: "github" }));
    await page.evaluate(() => window.qa.workspace.connect());
    await nav.getByRole("button", { name: "홈", exact: true }).click();
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByTestId("ws-nav-transfer").click();
    await panel.getByRole("tab", { name: "가져오기" }).click();
    await run.shot("github-import-idle");
    await panel.getByRole("button", { name: "견주어 보기" }).click();
    await expect(panel.getByTestId("import-preview")).toBeVisible();
    await run.shot("github-preview");
    await panel.getByRole("button", { name: /^고른 항목 \d+개 가져오기$/ }).click();
    await expect(panel.getByTestId("import-done")).toContainText("가져오기 브랜치에 커밋했습니다");
    await run.shot("github-done");
    await panel.getByRole("button", { name: "PR 작성" }).click();
    await expect(panel.getByTestId("import-pr")).toBeVisible();
    await run.shot("github-pr");
    run.note("pulls", remote.api.pulls);
    const branch = remote.api.pulls[0]?.head ?? "";
    await page.evaluate((b) => window.qa.workspace.checkout({ branch: b }), branch);
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    const row = page.getByTestId("tc-notes-TC-0004");
    await expect(row).toContainText("가져오기 PR 머지 전");
    await row.getByRole("button").click();
    await expect(page.getByTestId("tc-locked")).toContainText("가져오기 PR 을 머지할 때까지 고칠 수 없습니다");
    await expect(page.getByTestId("tc-form").getByLabel("제목")).toBeDisabled();
    await run.shot("github-locked");
    run.note("status-end", await page.evaluate(() => window.qa.workspace.status()));
    run.note("export-zip-bytes", readFileSync(join(work, "export.zip")).length);
  } finally {
    await run.close().catch(() => undefined);
    await remote.close();
    await server.close();
    rmSync(archives.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
