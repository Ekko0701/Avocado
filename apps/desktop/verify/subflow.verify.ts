import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFakeToolArchives, fakeToolDefinitions, serveFiles } from "../test-support/fake-tools";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYSUB_0123456789abcdefghijklm";

// QA 담당자처럼 워크스페이스 화면에서 공통 서브플로우(common/launch-clean.yaml)를 고치고 저장(커밋)한 뒤 PR 을 올린다.
// 원격은 예시 워크스페이스로 만든 로컬 git 서버와 가짜 GitHub API 다(실제 GitHub 은 건드리지 않는다)
test("공통 서브플로우 편집: 열기 → 규약 오류 → 저장(커밋) → PR", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  // 저장 전 Maestro 문법 검사에 쓸 가짜 JRE·Maestro(check-syntax 에 답한다)
  const archives = buildFakeToolArchives();
  const files = await serveFiles({ "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro });
  const toolsFile = join(archives.dir, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(fakeToolDefinitions(files.url, archives)));
  const run = await startRun("subflow", { env: remote.env, toolsFile });
  try {
    run.note("doctor", await doctor(run));
    const { page } = run;
    await page.evaluate(async () => {
      await window.qa.setup.installTool({ tool: "jre" });
      await window.qa.setup.installTool({ tool: "maestro" });
    });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");

    // 왼쪽 목록에서 앱을 고르고 공통 서브플로우 탭을 연다. 자주 쓰는 Maestro 명령은 편집기 옆에 늘 보인다
    await page.getByTestId("ws-nav-demo").click();
    await page.getByRole("tab", { name: /^공통 서브플로우/ }).click();
    const panel = page.getByTestId("subflows");
    await expect(page.getByTestId("subflow-used-by")).toHaveText("이 서브플로우를 부르는 플로우: TC-0101");
    await expect(page.getByTestId("maestro-help")).toContainText("extendedWaitUntil");
    await run.shot("opened");

    const editor = panel.getByLabel("서브플로우 내용");
    const original = await editor.inputValue();
    await editor.fill(`${original}- runScript: steal.js\n`);
    await panel.getByLabel("서브플로우 변경 요약").fill("longer wait");
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("runScript 는 쓰지 않는다");
    await page.getByTestId("subflow-message").scrollIntoViewIfNeeded();
    await run.shot("lint-blocks-save");

    await editor.fill(original.replace("timeout: 15000", "timeout: 30000"));
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("qa/qa-bot/app/demo/longer-wait 에 커밋했습니다");
    await panel.getByRole("button", { name: "PR 작성" }).click();
    await expect(page.getByTestId("subflow-pr")).toContainText("qa/qa-bot/app/demo/longer-wait");
    await page.getByTestId("subflow-pr").scrollIntoViewIfNeeded();
    await run.shot("saved-and-pr");

    run.note("remote", {
      pulls: remote.api.pulls.map((p) => ({ head: p.head, title: p.title })),
      file: remote.git(remote.bare, "show", "qa/qa-bot/app/demo/longer-wait:apps/demo/flows/ios/common/launch-clean.yaml"),
    });
  } finally {
    await run.close();
    await remote.close();
    await files.close();
    rmSync(archives.dir, { recursive: true, force: true });
  }
});
