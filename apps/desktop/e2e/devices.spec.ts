import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

// 이 Mac 의 실제 simctl 을 읽기만 한다(기기를 만들거나 켜거나 지우지 않는다)
test("기기 화면이 iOS 버전·기종을 고르는 칸, QA 기기 목록과 준비 버튼을 보여 준다", async () => {
  const { app, page } = await launchApp();
  await page.getByRole("button", { name: "기기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "기기", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "iOS 시뮬레이터 준비" })).toBeEnabled();
  const list = await page.evaluate(() => window.qa.devices.list());
  expect(Array.isArray(list.devices)).toBe(true);
  for (const d of list.devices.filter((x) => x.platform === "ios")) expect(d.name.startsWith("Avocado ") || d.name.startsWith("QA Tool ")).toBe(true);
  // Android 폰 연결 안내(ADR 0030). 연결된 폰이 있으면 종료 버튼이 없다(사람의 폰은 끄지 않는다)
  const prepare = page.getByRole("region", { name: "QA 기기 준비" });
  await prepare.getByRole("tab", { name: "Android 폰" }).click();
  await expect(page.getByTestId("phone-hint")).toBeVisible();
  await expect(prepare.getByRole("button", { name: "연결한 폰 찾기" })).toBeVisible();
  // Android 에뮬레이터 탭에는 AVD 고르기와 준비 버튼이 있다(SDK 가 없으면 꺼져 있다)
  await prepare.getByRole("tab", { name: "Android 에뮬레이터" }).click();
  await expect(prepare.getByLabel("AVD")).toBeVisible();
  await expect(prepare.getByRole("button", { name: "Android 에뮬레이터 준비" })).toBeVisible();
  await prepare.getByRole("tab", { name: "iOS 시뮬레이터" }).click();
  // 페이지는 창 높이에 맞고 두 칸의 머리말·본문·붙박이 줄이 폭을 다 쓴다
  expect(await page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.scrollHeight - main.clientHeight : -1;
  })).toBeLessThanOrEqual(1);
  const widths = await prepare.evaluate((pane) => [pane.clientWidth, ...[...pane.children].map((c) => (c as HTMLElement).offsetWidth)]);
  expect(widths.slice(1).every((w) => w === widths[0])).toBe(true);
  for (const d of list.devices.filter((x) => x.kind === "real")) {
    await expect(page.getByTestId(`device-android-${d.id}`).getByRole("button", { name: "종료" })).toHaveCount(0);
  }

  // 고를 수 있는 iOS 버전(최신 먼저)과 그 버전의 iPhone·iPad. 화면의 기본값은 기본 기종을 지원하는 가장 새 iOS
  const options = await page.evaluate(() => window.qa.devices.iosOptions());
  expect(options.defaultDeviceType).toBe("iPhone 17");
  if (options.runtimes.length > 0) {
    const versions = page.getByLabel("iOS 버전");
    await expect(versions.locator("option")).toHaveCount(options.runtimes.length);
    const preferred = options.runtimes.find((r) => r.deviceTypes.some((t) => t.name === "iPhone 17")) ?? options.runtimes[0];
    await expect(versions).toHaveValue(preferred?.id ?? "");
    if (preferred?.deviceTypes.some((t) => t.name === "iPhone 17")) await expect(page.getByLabel("기종")).toHaveValue("iPhone 17");
  }

  // 지우기는 IPC 에서 UDID 형식부터 검사한다(형식이 아니면 main 까지 가지 않는다)
  const bad = await page.evaluate(() => window.qa.devices.deleteIos({ id: "../../x" }).then(() => "ok", (e: unknown) => String(e)));
  expect(bad).toContain("invalid-input");
  await app.close();
});
