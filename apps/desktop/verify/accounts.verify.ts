import { expect, test, type ElectronApplication } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYACCOUNTS_0123456789abcdefgh";

// 테스트 계정: 연결 전(직접 추가) → 연결 뒤 앱 목록과 요약 → 값 넣기 → 다른 앱 → 그 밖의 값, 다크 모드와 좁은 창.
// 값은 테스트 전용 암호화로 임시 앱 데이터에만 저장한다(키체인을 쓰지 않는다)
test("accounts: 앱 목록과 값", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("accounts", { env: remote.env });
  const { page, app } = run;
  try {
    run.note("doctor", await doctor(run));
    await resize(app, 1440, 900);
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.secrets.set({ name: "account:old-app:OLD_KEY", value: "verify-old-value" }));
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "테스트 계정", exact: true }).click();
    const section = page.getByTestId("account-values");
    await expect(section.getByRole("form", { name: "테스트 계정 값 추가" })).toBeVisible();
    await run.shot("not-connected");

    await page.evaluate(() => window.qa.workspace.connect());
    await nav.getByRole("button", { name: "홈", exact: true }).click();
    await nav.getByRole("button", { name: "테스트 계정", exact: true }).click();
    await expect(section.getByTestId("account-values-summary")).toHaveText("아직 넣지 않은 값 3개");
    await page.waitForTimeout(300);
    await run.shot("first-app");
    run.note("main-fits", await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? { scroll: main.scrollHeight, client: main.clientHeight } : null;
    }));

    const row = section.getByTestId("secret-account:demo:DEMO_TEST_PASSWORD");
    await row.getByLabel("DEMO_TEST_PASSWORD 입력").fill("verify-local-pw-2026");
    await row.getByRole("button", { name: "저장" }).click();
    await expect(row.getByTestId("secret-status")).toHaveText("저장됨");
    await expect(section.getByTestId("account-values-summary")).toHaveText("아직 넣지 않은 값 2개");
    await run.shot("value-saved");

    await section.getByTestId("account-nav-sample").click();
    await expect(section.getByTestId("account-app-sample")).toBeVisible();
    await page.waitForTimeout(300);
    await run.shot("second-app");

    await section.getByTestId("account-nav-others").click();
    await expect(section.getByTestId("account-values-others")).toContainText("old-app · OLD_KEY");
    await page.waitForTimeout(300);
    await run.shot("others");
    run.note("no-value-in-dom", !(await page.content()).includes("verify-local-pw-2026"));

    await section.getByTestId("account-nav-sample").click();
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(800);
    await run.shot("second-app-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });

    await resize(app, 900, 760);
    await page.waitForTimeout(400);
    await run.shot("narrow");
  } finally {
    await run.close();
    await remote.close();
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}
