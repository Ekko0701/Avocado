import { expect, test } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2ESUBFLOW_0123456789abcdefghijklmnop";

test("공통 서브플로우: 워크스페이스 화면에서 common/launch-clean.yaml 을 고쳐 앱 설정 브랜치에 커밋하고 PR 을 만든다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "워크스페이스", exact: true }).click();

    const panel = page.getByTestId("subflows");
    await panel.getByLabel("서브플로우 앱").selectOption("demo");
    await expect(panel.getByLabel("서브플로우 파일")).toHaveValue("flows/demo/ios/common/launch-clean.yaml");
    await expect(page.getByTestId("subflow-used-by")).toHaveText("이 서브플로우를 부르는 플로우: TC-0101");
    const editor = panel.getByLabel("서브플로우 내용");
    const original = await editor.inputValue();
    expect(original).toContain("clearKeychain");
    await expect(panel.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();

    // 규약에 어긋나면 커밋하지 않고 이유를 보여 준다
    await editor.fill(`${original}- runScript: steal.js\n`);
    await panel.getByLabel("서브플로우 변경 요약").fill("longer wait");
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("서브플로우 규약 오류");
    await expect(page.getByTestId("subflow-message")).toContainText("runScript 는 쓰지 않는다");
    await panel.getByRole("button", { name: "되돌리기" }).click();
    await expect(editor).toHaveValue(original);

    // 대기 시간을 늘려 저장하면 그 앱의 앱 설정 작업 브랜치에 커밋한다
    const edited = original.replace("timeout: 15000", "timeout: 30000");
    expect(edited).not.toBe(original);
    await editor.fill(edited);
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("qa/qa-bot/app/demo/longer-wait 에 커밋했습니다");
    await expect(editor).toHaveValue(edited);
    await expect(panel).toContainText("진행 중인 앱 설정 브랜치 qa/qa-bot/app/demo/longer-wait 에서 읽었습니다");

    // PR 작성: 브랜치를 올리고 PR 을 만든다
    await panel.getByRole("button", { name: "PR 작성" }).click();
    await expect(page.getByTestId("subflow-pr")).toContainText("을 만들었습니다(qa/qa-bot/app/demo/longer-wait)");
    expect(remote.api.pulls).toEqual([
      expect.objectContaining({ head: "qa/qa-bot/app/demo/longer-wait", base: "main", title: "subflow: demo ios/common/launch-clean.yaml longer wait" }),
    ]);
    expect(remote.git(remote.bare, "show", "qa/qa-bot/app/demo/longer-wait:flows/demo/ios/common/launch-clean.yaml")).toContain("timeout: 30000");
    expect(remote.git(remote.bare, "show", "--name-only", "--format=%s", "qa/qa-bot/app/demo/longer-wait").split("\n").filter(Boolean)).toEqual([
      "subflow: demo/ios launch-clean.yaml longer wait",
      "flows/demo/ios/common/launch-clean.yaml",
    ]);
    await app.close();
  } finally {
    await remote.close();
  }
});
