import { expect, test, type ElectronApplication } from "@playwright/test";
import { startFakeGitHub } from "../../../packages/remote/src/testing/fake-github";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYSETTINGS_0123456789abcdefgh";

// 설정 2단: 왼쪽 구역 목록(상태 한 줄), 오른쪽 구역 하나. GitHub(토큰·저장소·연결 확인) → Claude(앱 방식, API 키 방식) → 증적 → 기기 → 앱 정보,
// 다크 모드와 좁은 창. GitHub 은 가짜 API 다. Claude 데스크톱 앱 등록은 누르지 않는다(실제 홈의 Claude 설정 파일을 고친다)
test("settings: 구역 목록과 구역별 화면", async () => {
  const year = new Date().getFullYear();
  const fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-workspace": { push: true }, [`acme/qa-evidence-${year}`]: { push: true } } });
  const run = await startRun("settings", { env: { QA_E2E_GITHUB_API: fake.url } });
  const { page, app } = run;
  try {
    run.note("doctor", await doctor(run));
    await resize(app, 1440, 900);
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("settings-nav-github")).toContainText("토큰을 넣지 않았습니다");
    await run.shot("github-empty");

    // GitHub: 토큰 저장 → 조직 저장 → 연결 확인. 구역 목록의 상태 줄이 따라온다
    const github = page.getByRole("region", { name: "GitHub" });
    const tokenRow = page.getByTestId("secret-githubToken");
    await tokenRow.getByLabel("GitHub 토큰 입력").fill(TOKEN);
    await tokenRow.getByRole("button", { name: "저장" }).click();
    await expect(tokenRow.getByTestId("secret-status")).toHaveText("저장됨");
    await expect(page.getByTestId("settings-nav-github")).toContainText("저장소를 정하지 않았습니다");
    await github.getByLabel("GitHub 조직").fill("acme");
    const foot = github.getByTestId("settings-foot");
    await foot.getByRole("button", { name: "저장", exact: true }).click();
    await expect(foot.getByRole("status")).toHaveText("저장했습니다");
    await foot.getByRole("button", { name: "연결 확인" }).click();
    await expect(page.getByTestId("github-verify")).toContainText("acme/qa-workspace");
    await expect(page.getByTestId("settings-nav-github")).toContainText("acme/qa-workspace");
    await run.shot("github-verified");
    const fits = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? { scroll: main.scrollHeight, client: main.clientHeight } : null;
    });
    run.note("main-fits", fits);
    expect(fits && fits.scroll - fits.client).toBeLessThanOrEqual(1);

    // Claude: 앱 방식 → API 키 방식(키·상한·사용량이 나온다) → 상한만 저장해도 방식은 그대로
    await page.getByTestId("settings-nav-claude").click();
    await expect(page.getByTestId("claude-listening")).toBeVisible();
    await run.shot("claude-app");
    const claude = page.getByRole("region", { name: "Claude" });
    await claude.getByRole("radio", { name: /Anthropic API 키/ }).check();
    await expect(page.getByTestId("agent-usage")).toBeVisible();
    await claude.getByLabel("월 LLM 비용 상한 (USD)").fill("50");
    await claude.getByTestId("settings-foot").getByRole("button", { name: "저장" }).click();
    await expect(page.getByTestId("agent-usage")).toContainText("상한 $50.00");
    await expect(claude.getByRole("radio", { name: /Anthropic API 키/ })).toBeChecked();
    run.note("provider-after-budget-save", await page.evaluate(() => window.qa.settings.get().then((s) => s.settings.agent)));
    await run.shot("claude-api");
    await claude.getByRole("radio", { name: /내 Claude 앱/ }).check();
    await expect(page.getByTestId("claude-listening")).toBeVisible();

    // 증적: 보관 일수 저장, 올라가는 곳
    await page.getByTestId("settings-nav-evidence").click();
    const evidence = page.getByRole("form", { name: "증적" });
    await evidence.getByLabel("로컬 증적 보관 일수").fill("14");
    await evidence.getByRole("button", { name: "저장" }).click();
    await expect(evidence.getByRole("status")).toHaveText("저장했습니다");
    await expect(page.getByTestId("evidence-target")).toContainText(`acme/qa-evidence-${year}`);
    await expect(page.getByTestId("settings-nav-evidence")).toContainText("14일 보관 · 업로드 꺼짐");
    await run.shot("evidence");

    await page.getByTestId("settings-nav-devices").click();
    await expect(page.getByRole("form", { name: "기기" }).getByLabel("QA 기기 언어")).toHaveValue("ko_KR");
    await run.shot("devices");

    await page.getByTestId("settings-nav-app").click();
    await expect(page.getByTestId("db-status")).toContainText("스키마");
    await run.shot("app");

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByTestId("settings-nav-claude").click();
    await page.waitForTimeout(800);
    await run.shot("claude-app-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });

    await resize(app, 900, 760);
    await page.getByTestId("settings-nav-github").click();
    await page.waitForTimeout(400);
    await run.shot("narrow");
  } finally {
    await run.close();
    await fake.close();
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}
