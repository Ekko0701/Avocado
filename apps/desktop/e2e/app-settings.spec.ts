import { expect, test } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2EAPPCFG_0123456789abcdefghijklmnop";

test("앱 설정: 워크스페이스 화면에서 타깃·계정 역할을 고치고 새 앱을 만들어 앱 설정 브랜치에 커밋하고 PR 을 만든다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();

    // 화면을 열면 첫 앱이 골라져 있다. 왼쪽 목록에 타깃과 테스트 케이스 수가 보인다
    const panel = page.getByTestId("app-settings");
    await expect(page.getByTestId("ws-nav-demo")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("ws-nav-demo")).toContainText("iOS · 테스트 케이스 1개");
    await expect(panel.getByRole("heading", { name: "Demo (demo)" })).toBeVisible();
    // 양식 카드의 머리말·본문·저장 줄이 폭을 다 쓰고(왼쪽에서 시작), 페이지는 창 높이에 맞는다
    const widths = await panel.evaluate((form) => [form.clientWidth, ...[...form.children].map((c) => (c as HTMLElement).offsetWidth)]);
    expect(widths.slice(1).every((w) => w === widths[0])).toBe(true);
    expect(await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? main.scrollHeight - main.clientHeight : -1;
    })).toBeLessThanOrEqual(1);
    await expect(panel.getByLabel("앱 이름")).toHaveValue("Demo");
    await expect(panel.getByLabel("iOS 사용", { exact: true })).toBeChecked();
    await expect(panel.getByLabel("iOS 앱 ID", { exact: true })).toHaveValue("com.example.demo");
    await expect(panel.getByLabel("Android 사용", { exact: true })).not.toBeChecked();
    await expect(panel.getByLabel("Android 앱 ID", { exact: true })).toBeDisabled();
    await expect(panel.getByLabel("역할 이름 1")).toHaveValue("signup");

    // Android 타깃과 계정 역할을 더한다. 형식이 틀리면 저장할 수 없다
    await panel.getByLabel("Android 사용", { exact: true }).check();
    await panel.getByLabel("변경 요약").fill("android and member");
    await expect(page.getByTestId("app-settings-problems")).toContainText("Android 앱 ID 를 공백 없이 씁니다");
    await expect(panel.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();
    await panel.getByLabel("Android 앱 ID", { exact: true }).fill("com.example.demo");
    await panel.getByRole("button", { name: "역할 추가" }).click();
    await panel.getByLabel("역할 이름 2").fill("member");
    await panel.getByLabel("설명 2").fill("미리 만든 로그인 계정");
    await panel.getByLabel("키 2").fill("DEMO_MEMBER_EMAIL, DEMO_MEMBER_PASSWORD");
    await expect(page.getByTestId("app-settings-problems")).toHaveCount(0);
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("app-settings-message")).toContainText("qa/qa-bot/app/demo/android-and-member 에 커밋했습니다");

    // PR 작성: 앱 설정 브랜치를 올리고 PR 을 만든다
    await panel.getByRole("button", { name: "PR 작성" }).click();
    await expect(page.getByTestId("app-settings-pr")).toContainText("PR #7 을 만들었습니다(qa/qa-bot/app/demo/android-and-member)");
    expect(remote.api.pulls).toEqual([expect.objectContaining({ head: "qa/qa-bot/app/demo/android-and-member", base: "main", title: "app: demo android and member" })]);
    expect(remote.git(remote.bare, "show", "qa/qa-bot/app/demo/android-and-member:apps/demo/app.yaml")).toContain("android:");
    expect(remote.git(remote.bare, "show", "qa/qa-bot/app/demo/android-and-member:apps/demo/accounts.yaml")).toContain("keys: [DEMO_MEMBER_EMAIL, DEMO_MEMBER_PASSWORD]");

    // TC 편집 화면에 android 타깃과 member 역할이 나온다
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await page.getByRole("button", { name: "demo/TC-0101" }).click();
    const tcForm = page.getByTestId("tc-form");
    await expect(tcForm.getByLabel("android", { exact: true })).toBeVisible();
    await expect(tcForm.getByLabel("계정 역할").locator("option", { hasText: "member" })).toHaveCount(1);

    // 새 앱을 만든다: workspace.yaml 앱 목록과 app.yaml
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByTestId("ws-nav-new").click();
    await expect(panel.getByRole("heading", { name: "새 앱" })).toBeVisible();
    await panel.getByLabel("새 앱 ID").fill("demo");
    await expect(page.getByTestId("app-settings-problems")).toContainText("이미 있는 앱입니다: demo");
    await panel.getByLabel("새 앱 ID").fill("notes");
    await panel.getByLabel("앱 이름").fill("Notes");
    await panel.getByLabel("iOS 사용", { exact: true }).check();
    await panel.getByLabel("iOS 앱 ID", { exact: true }).fill("com.example.notes");
    await panel.getByLabel("변경 요약").fill("add notes app");
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("app-settings-message")).toContainText("qa/qa-bot/app/notes/add-notes-app 에 커밋했습니다");
    await expect(page.getByTestId("app-settings-message")).toContainText("새 앱을 워크스페이스에 더했습니다");
    // 만든 앱이 왼쪽 목록에서 골라진다(main 에 들어가기 전)
    await expect(page.getByTestId("ws-nav-notes")).toHaveAttribute("aria-current", "page");
    await expect(panel.getByLabel("앱 이름")).toHaveValue("Notes");
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await expect(page.getByLabel("새 테스트 케이스 앱").locator("option", { hasText: "Notes" })).toHaveCount(1);
    await app.close();
  } finally {
    await remote.close();
  }
});
