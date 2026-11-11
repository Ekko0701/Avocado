import { expect, test, type ElectronApplication } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYWORKSPACE_0123456789abcdefg";

// 워크스페이스 화면: 연결 전 → 연결 → 앱 설정(왼쪽 앱 목록, 오른쪽 탭) → 공통 서브플로우(파일·편집기·Maestro 명령) → 문제 → 새 앱,
// 다크 모드와 좁은 창. 원격은 가짜 GitHub·로컬 git 이다. 저장(커밋)·PR 은 app-settings·subflow 여정이 본다
test("workspace: 앱 목록과 탭", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("workspace", { env: remote.env });
  const { page, app } = run;
  try {
    run.note("doctor", await doctor(run));
    await resize(app, 1440, 900);
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "워크스페이스", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("아직 이 Mac 에 받지 않았습니다");
    await run.shot("not-connected");

    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    const settings = page.getByTestId("app-settings");
    await expect(settings.getByLabel("앱 이름")).toHaveValue("Demo");
    await page.waitForTimeout(300);
    await run.shot("app-settings");
    // 양식 카드도 머리말·본문·저장 줄이 폭을 다 쓰고, 페이지는 창 높이에 맞는다
    run.note("layout", {
      widths: await settings.evaluate((form) => [form.clientWidth, ...[...form.children].map((c) => (c as HTMLElement).offsetWidth)]),
      main: await page.evaluate(() => {
        const main = document.querySelector("main");
        return main ? { scroll: main.scrollHeight, client: main.clientHeight } : null;
      }),
    });

    await page.getByRole("tab", { name: /^공통 서브플로우/ }).click();
    await expect(page.getByTestId("subflow-used-by")).toBeVisible();
    await page.waitForTimeout(300);
    await run.shot("subflows");
    // 탭을 오가도 고치던 내용이 남는다
    await page.getByTestId("subflows").getByLabel("서브플로우 내용").fill("# 고치는 중\n");
    await page.getByRole("tab", { name: "앱 설정" }).click();
    await settings.getByLabel("앱 이름").fill("Demo 2");
    await page.getByTestId("app-settings").getByRole("tab", { name: /^공통 서브플로우/ }).click();
    await expect(page.getByTestId("subflows").getByLabel("서브플로우 내용")).toHaveValue("# 고치는 중\n");
    await page.getByTestId("subflows").getByRole("tab", { name: "앱 설정" }).click();
    await expect(settings.getByLabel("앱 이름")).toHaveValue("Demo 2");

    await page.getByTestId("ws-nav-sample").click();
    await expect(settings.getByRole("heading", { name: "Sample (sample)" })).toBeVisible();
    await page.waitForTimeout(300);
    await run.shot("second-app");

    await page.getByTestId("ws-nav-problems").click();
    await expect(page.getByRole("region", { name: "워크스페이스 문제" })).toBeVisible();
    await page.waitForTimeout(300);
    await run.shot("problems");

    await page.getByTestId("ws-nav-new").click();
    await expect(settings.getByLabel("새 앱 ID")).toBeVisible();
    await page.waitForTimeout(300);
    await run.shot("new-app");

    await page.getByTestId("ws-nav-demo").click();
    await page.getByRole("tab", { name: /^공통 서브플로우/ }).click();
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(800);
    await run.shot("subflows-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });

    await resize(app, 900, 760);
    await page.waitForTimeout(400);
    await run.shot("narrow-subflows");
    await page.getByTestId("subflows").getByRole("tab", { name: "앱 설정" }).click();
    await page.waitForTimeout(300);
    await run.shot("narrow-settings");
  } finally {
    await run.close();
    await remote.close();
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}
