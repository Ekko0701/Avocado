import { expect, test } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2EUNMERGED_0123456789abcdefghijklm";

test("GitHub 방식: 새 앱의 앱 설정 PR 이 머지되기 전에 그 앱의 테스트 케이스를 저장하면, 앱 설정이 없는 브랜치를 만들지 않고 이유를 보인다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    // 새 앱을 저장하면 앱 설정 브랜치(qa/qa-bot/app/shop/…)로 옮겨 가고, 그 앱이 테스트 케이스 화면에 보인다
    const saved = await page.evaluate(() =>
      window.qa.workspace.saveApp({ app: "shop", create: true, name: "Shop", locale: null, targets: [{ target: "ios", appId: "com.example.shop" }], roles: [], summary: "shop app" }),
    );
    expect(saved.branch).toBe("qa/qa-bot/app/shop/shop-app");

    await page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await page.getByLabel("새 테스트 케이스 앱").selectOption("shop");
    await page.getByRole("button", { name: "새 테스트 케이스" }).click();
    await expect(page.getByRole("heading", { name: /shop\/TC-0102/ })).toBeVisible();
    await expect(page.getByTestId("tc-lint")).toContainText("린트 문제 없음");
    await page.getByRole("button", { name: "저장(커밋)" }).click();

    await expect(page.getByTestId("tc-message")).toContainText("shop 앱 설정이 아직 main 에 없다(qa/qa-bot/app/shop/shop-app). 앱 설정 PR 을 머지하고 동기화한 뒤 테스트 케이스를 저장한다");
    const branches = await page.evaluate(() => window.qa.workspace.branches());
    expect(branches.current).toBe("qa/qa-bot/app/shop/shop-app");
    expect(branches.branches.map((b) => b.name)).toEqual(["qa/qa-bot/app/shop/shop-app"]);
    expect((await page.evaluate(() => window.qa.workspace.status())).issues).toBe(0);
  } finally {
    await remote.close();
  }
});
