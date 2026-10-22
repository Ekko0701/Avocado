import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

test("기기 화면이 QA 기기 목록과 준비 버튼을 보여 준다", async () => {
  const { app, page } = await launchApp();
  await page.getByRole("button", { name: "기기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "기기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "iOS 시뮬레이터 준비" })).toBeEnabled();
  const list = await page.evaluate(() => window.qa.devices.list());
  expect(Array.isArray(list.devices)).toBe(true);
  for (const d of list.devices.filter((x) => x.platform === "ios")) expect(d.name.startsWith("Avocado ") || d.name.startsWith("QA Tool ")).toBe(true);
  await app.close();
});
