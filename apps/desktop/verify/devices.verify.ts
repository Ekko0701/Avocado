import { expect, test, type ElectronApplication } from "@playwright/test";
import { doctor, startRun } from "./harness";

// 기기 화면: 왼쪽 기기 목록, 오른쪽 준비 탭(iOS 시뮬레이터 | Android 에뮬레이터 | Android 폰), 좁은 창.
// 이 Mac 의 실제 기기 목록을 읽기만 한다. 준비·종료·삭제는 누르지 않는다(기기를 만들거나 켜거나 지우지 않는다)
test("devices: 목록과 준비 탭", async () => {
  const run = await startRun("devices");
  const { page, app } = run;
  try {
    run.note("doctor", await doctor(run));
    await resize(app, 1440, 900);
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기기", exact: true }).click();
    const prepare = page.getByRole("region", { name: "QA 기기 준비" });
    await expect(prepare.getByRole("button", { name: "iOS 시뮬레이터 준비" })).toBeEnabled();
    await expect(page.getByRole("region", { name: "기기 목록" }).getByText("불러오는 중")).toHaveCount(0, { timeout: 60_000 });
    run.note("devices", (await page.evaluate(() => window.qa.devices.list())).devices.map((d) => `${d.platform} ${d.kind} ${d.state}`));
    await run.shot("ios");
    await prepare.getByRole("tab", { name: "Android 에뮬레이터" }).click();
    await expect(prepare.getByLabel("AVD")).toBeVisible();
    await run.shot("android");
    await prepare.getByRole("tab", { name: "Android 폰" }).click();
    await expect(page.getByTestId("phone-hint")).toBeVisible();
    await run.shot("phone");
    await resize(app, 900, 760);
    await page.waitForTimeout(400);
    await run.shot("narrow");
  } finally {
    await run.close();
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}
