import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// 패키징한 .app 에서 로컬 DB 가 열리는지 확인한다 (T-102 완료 기준).
// 먼저 패키징한다: pnpm --filter @qa/desktop package
// 실행: pnpm --filter @qa/desktop test:e2e:packaged
// 패키징한 앱은 테스트용 환경 변수(QA_USER_DATA_DIR 등)를 무시하므로 실제 앱 데이터 폴더를 쓴다.
const APP = resolve(__dirname, "../dist/mac-arm64/Avocado.app/Contents/MacOS/Avocado");

test.skip(process.env["QA_E2E_PACKAGED"] !== "1", "QA_E2E_PACKAGED=1 일 때만 실행");

test("패키징한 앱이 뜨고 로컬 DB 를 최신 스키마로 연다", async () => {
  expect(existsSync(APP), `패키징 결과가 없다: ${APP}`).toBe(true);
  const app = await electron.launch({ executablePath: APP });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const isPackaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
    expect(isPackaged).toBe(true);
    const status = await page.evaluate(() => window.qa.db.status());
    expect(status.schemaVersion).toBe(status.latestVersion);
    expect(status.journalMode).toBe("wal");
    expect(status.path).toMatch(/Application Support\/Avocado\/db\.sqlite$/);
    // 실제 데이터 폴더라 마법사 완료 여부에 따라 첫 화면이 홈이거나 마법사다.
    await expect(page.getByRole("heading", { name: /^(홈|설정 마법사)$/ })).toBeVisible();
  } finally {
    await app.close();
  }
});
