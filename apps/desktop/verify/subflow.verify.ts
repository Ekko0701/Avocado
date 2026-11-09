import { expect, test } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYSUB_0123456789abcdefghijklm";

// QA 담당자처럼 워크스페이스 화면에서 공통 서브플로우(common/launch-clean.yaml)를 고치고 저장(커밋)한 뒤 PR 을 올린다.
// 원격은 예시 워크스페이스로 만든 로컬 git 서버와 가짜 GitHub API 다(실제 GitHub 은 건드리지 않는다)
test("공통 서브플로우 편집: 열기 → 규약 오류 → 저장(커밋) → PR", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("subflow", { env: remote.env });
  try {
    run.note("doctor", await doctor(run));
    const { page } = run;
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");

    const panel = page.getByTestId("subflows");
    await panel.getByLabel("서브플로우 앱").selectOption("demo");
    await expect(page.getByTestId("subflow-used-by")).toHaveText("이 서브플로우를 부르는 플로우: TC-0101");
    await panel.scrollIntoViewIfNeeded();
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
      file: remote.git(remote.bare, "show", "qa/qa-bot/app/demo/longer-wait:flows/demo/ios/common/launch-clean.yaml"),
    });
  } finally {
    await run.close();
    await remote.close();
  }
});
