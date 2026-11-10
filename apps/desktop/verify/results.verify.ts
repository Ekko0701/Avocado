import { expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, startRun } from "./harness";
import { seedRuns } from "./seed-runs";

// 결과 화면 2단: 왼쪽 실행 목록(칩·검색)·테스트 케이스 표, 오른쪽 스텝·캡처와 증적 탭. 넓은 창·좁은 창·다크 모드를 남긴다.
// 실행 기록은 실제 Maestro 산출물 픽스처다(기기 없음)
test("results: 2단 결과 화면", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-results-"));
  let run = await startRun("results-boot", { userDataDir });
  await run.close();
  seedRuns(userDataDir, [
    { id: "run-fail", fixture: "ios-fail", target: "ios", status: "failed", createdAt: "2026-11-10T01:00:00.000Z" },
    { id: "run-pass-android", fixture: "android-pass", target: "android", status: "passed", createdAt: "2026-11-10T00:30:00.000Z" },
    { id: "run-login-fail", fixture: "ios-fail", target: "ios", status: "failed", createdAt: "2026-11-09T09:20:00.000Z", tcId: "TC-0002", title: "학생 계정 로그인" },
    { id: "run-pass", fixture: "ios-pass", target: "ios", status: "passed", createdAt: "2026-11-09T08:10:00.000Z" },
    { id: "run-onboarding", fixture: "android-pass", target: "android", status: "passed", createdAt: "2026-11-08T07:40:00.000Z", tcId: "TC-0105", title: "온보딩 첫 화면" },
  ]);
  run = await startRun("results", { userDataDir });
  const { page } = run;
  try {
    run.note("doctor", await doctor(run));
    await resize(run.app, 1440, 900);
    await page.getByRole("button", { name: "결과", exact: true }).click();
    await expect(page.getByTestId("results-failure")).toBeVisible();
    await expect(page.getByTestId("log-view").locator(".log-line.focus")).toBeVisible();
    await run.shot("failed-log");
    const fits = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? { scroll: main.scrollHeight, client: main.clientHeight } : null;
    });
    run.note("main-fits", fits);
    expect(fits && fits.scroll - fits.client).toBeLessThanOrEqual(1);

    const evidence = page.getByRole("tablist", { name: "증적" });
    await evidence.getByRole("tab", { name: "화면 트리" }).click();
    await expect(page.getByTestId("hierarchy")).toBeVisible();
    await run.shot("failed-tree");
    await evidence.getByRole("tab", { name: /캡처 \d+장/ }).click();
    await expect(page.getByTestId("capture-strip").locator("img").first()).toBeVisible();
    await run.shot("failed-captures");

    const list = page.getByRole("region", { name: "실행", exact: true });
    await list.getByRole("button", { name: /^실패 \d+$/ }).click();
    await run.shot("filter-failed");
    await list.getByRole("button", { name: /^전체 \d+$/ }).click();
    await list.getByLabel("실행 검색").fill("android");
    await run.shot("search-android");
    await list.getByLabel("실행 검색").fill("");

    await list.getByRole("tab", { name: "테스트 케이스" }).click();
    await page.getByTestId("tc-cell-TC-0101-android").click();
    await expect(page.getByTestId("results-detail")).toContainText("통과");
    await expect(page.getByTestId("capture-img")).toBeVisible();
    await run.shot("matrix-passed");

    await theme(run.app, "dark");
    await page.emulateMedia({ colorScheme: "dark" });
    // 색 전환(transition)이 끝난 뒤 찍는다
    await page.waitForTimeout(800);
    await run.shot("matrix-passed-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await theme(run.app, "light");

    // 좁은 창: 목록 아래에 상세, 화면 전체 스크롤
    await resize(run.app, 900, 760);
    await list.getByRole("tab", { name: "실행" }).click();
    await page.getByTestId("results-run-run-fail").click();
    await expect(page.getByTestId("results-failure")).toBeVisible();
    await page.waitForTimeout(400);
    await run.shot("narrow");
  } finally {
    await run.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}

async function theme(app: ElectronApplication, source: "dark" | "light") {
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s;
  }, source);
}
