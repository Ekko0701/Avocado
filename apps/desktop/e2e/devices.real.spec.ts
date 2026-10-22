import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

// 실제 iOS 시뮬레이터·Android 에뮬레이터를 준비하고, 앱 밖에서 simctl·adb 로 언어·애니메이션을 확인한다.
// ADR 0001 발견 1(런타임별 지원 기기)·2(플랫폼별 기기 언어)를 실제 기기에서 재현·처리하는지 본다.
// 시뮬레이터 "Avocado iPhone 17"(예전 이름 "QA Tool iPhone 17" 도 그대로 쓴다)이 없으면 새로 만든다(앱을 실제로 쓸 때와 같다).
//   QA_E2E_REAL_DEVICES=1 pnpm --filter @qa/desktop exec playwright test e2e/devices.real.spec.ts
test.skip(process.env["QA_E2E_REAL_DEVICES"] !== "1", "QA_E2E_REAL_DEVICES=1 일 때만 실행");

const ADB = join(process.env["ANDROID_HOME"] || join(homedir(), "Library", "Android", "sdk"), "platform-tools", "adb");
const sh = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8" }).trim();

test("iOS·Android QA 기기를 설정 언어(ko_KR)로 준비하고 애니메이션을 줄인다", async () => {
  test.setTimeout(15 * 60_000);
  const { app, page } = await launchApp();

  const ios = await page.evaluate(() => window.qa.devices.prepareIos({}));
  expect(ios).toMatchObject({ state: "booted", locale: "ko_KR" });
  expect(["Avocado iPhone 17", "QA Tool iPhone 17"]).toContain(ios.name);
  expect(ios.osVersion).not.toBe("27.1"); // 27.1 은 iPhone 17 을 지원하지 않는다(ADR 0001 발견 1)
  expect(sh("/usr/bin/xcrun", ["simctl", "spawn", ios.id, "defaults", "read", "-g", "AppleLocale"])).toBe("ko_KR");
  expect(sh("/usr/bin/xcrun", ["simctl", "spawn", ios.id, "defaults", "read", "com.apple.Accessibility", "ReduceMotionEnabled"])).toBe("1");

  const android = await page.evaluate(() => window.qa.devices.prepareAndroid({}));
  expect(android).toMatchObject({ state: "booted", locale: "ko-KR" });
  const serial = android.serial ?? "";
  expect(sh(ADB, ["-s", serial, "shell", "getprop", "persist.sys.locale"])).toBe("ko-KR");
  for (const key of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
    expect(sh(ADB, ["-s", serial, "shell", "settings", "get", "global", key])).toMatch(/^0(\.0)?$/);
  }

  // 같은 요청을 다시 하면 이미 맞춰진 기기를 그대로 쓴다(멱등).
  const again = await page.evaluate(() => window.qa.devices.prepareIos({}));
  expect(again.id).toBe(ios.id);

  await page.evaluate((id) => window.qa.devices.shutdown({ platform: "android", id }), android.id);
  await page.evaluate((id) => window.qa.devices.shutdown({ platform: "ios", id }), ios.id);
  await app.close();
});
