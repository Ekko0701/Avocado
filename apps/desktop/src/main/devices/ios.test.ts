import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appleLocaleValues, findNewestDevice, iosDeviceChoices, iosVersionFromRuntimeId, NoRuntimeError, pickRuntime, type SimRuntime } from "./ios";

// 2026-10-21 이 Mac 의 실제 `xcrun simctl list runtimes -j` (iPhone 기기 유형만 남김)
const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "simctl-runtimes-2026-10-21.json"), "utf8"),
) as { runtimes: SimRuntime[] };

describe("pickRuntime (ADR 0001 발견 1)", () => {
  it("최신 런타임(iOS 27.1)이 iPhone 17 을 지원하지 않으면 지원하는 최신(27.0)을 고른다", () => {
    const { runtime, deviceTypeId } = pickRuntime(fixture.runtimes, "iPhone 17");
    expect(runtime.name).toBe("iOS 27.0");
    expect(deviceTypeId).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-17");
  });

  it("iOS 27.1 이 지원하는 유일한 기기는 27.1 을 고른다", () => {
    expect(pickRuntime(fixture.runtimes, "iPhone Duo").runtime.name).toBe("iOS 27.1");
  });

  it("어떤 런타임도 지원하지 않으면 고칠 방법을 담은 오류를 낸다", () => {
    expect(() => pickRuntime(fixture.runtimes, "iPhone 3G")).toThrow(NoRuntimeError);
  });

  it("고른 런타임이 그 기종을 지원하면 그 런타임, 아니면 이유를 담은 오류", () => {
    expect(pickRuntime(fixture.runtimes, "iPhone 17", "com.apple.CoreSimulator.SimRuntime.iOS-26-5").runtime.version).toBe("26.5");
    expect(() => pickRuntime(fixture.runtimes, "iPhone 17", "com.apple.CoreSimulator.SimRuntime.iOS-27-1")).toThrow(/iOS 27\.1 은 'iPhone 17' 을 지원하지 않는다/);
    expect(() => pickRuntime(fixture.runtimes, "iPhone 17", "com.apple.CoreSimulator.SimRuntime.iOS-25-0")).toThrow(/25\.0 런타임이 이 Mac 에 없다/);
  });

  it("버전은 숫자로 비교한다(27.10 > 27.9)", () => {
    const type = { name: "X", identifier: "x" };
    const runtimes: SimRuntime[] = [
      { identifier: "a", name: "iOS 27.9", version: "27.9", platform: "iOS", supportedDeviceTypes: [type] },
      { identifier: "b", name: "iOS 27.10", version: "27.10", platform: "iOS", supportedDeviceTypes: [type] },
      { identifier: "c", name: "iOS 28.0", version: "28.0", platform: "iOS", isAvailable: false, supportedDeviceTypes: [type] },
    ];
    expect(pickRuntime(runtimes, "X").runtime.identifier).toBe("b");
  });
});

describe("기타 해석", () => {
  it("언어 값", () => {
    expect(appleLocaleValues("ko_KR")).toEqual({ appleLocale: "ko_KR", appleLanguage: "ko-KR" });
    expect(appleLocaleValues("en_US")).toEqual({ appleLocale: "en_US", appleLanguage: "en-US" });
  });

  it("런타임 식별자에서 버전", () => {
    expect(iosVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.iOS-27-0")).toBe("27.0");
    expect(iosVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe("26.5");
  });

  it("조건에 맞는 사용 가능한 기기 중 가장 새 iOS 것을 찾는다", () => {
    const devices = {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "1", name: "Avocado iPhone 17 (iOS 26.5)", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
        { udid: "2", name: "QA Tool iPhone 17", state: "Booted", isAvailable: true },
        { udid: "3", name: "Avocado iPhone 17 (iOS 27.0)", state: "Shutdown", isAvailable: false },
      ],
    };
    const iphone17 = (name: string) => name.includes("iPhone 17");
    expect(findNewestDevice(devices, (d) => iphone17(d.name))?.device.udid).toBe("2");
    expect(findNewestDevice(devices, (d, rt) => iphone17(d.name) && rt.endsWith("26-5"))?.device.udid).toBe("1");
    expect(findNewestDevice(devices, (d) => d.name === "없음")).toBeNull();
  });
});

describe("iosDeviceChoices (기기 화면의 고르기)", () => {
  it("쓸 수 있는 iOS 런타임을 최신 먼저, 각 런타임이 지원하는 iPhone·iPad 만 simctl 순서로", () => {
    const choices = iosDeviceChoices(fixture.runtimes);
    expect(choices.map((r) => r.version)).toEqual(["27.1", "27.0", "26.5"]);
    expect(choices[0]?.deviceTypes).toEqual([{ name: "iPhone Duo", family: "iPhone" }]);
    expect(choices[1]?.deviceTypes.map((t) => t.name)).toContain("iPhone 17");
    expect(choices[1]?.deviceTypes.every((t) => t.family === "iPhone")).toBe(true);
  });

  it("iPhone·iPad 가 아닌 기기와 쓸 수 없는 런타임은 뺀다. productFamily 가 없으면 이름으로 가린다", () => {
    const runtimes: SimRuntime[] = [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        name: "iOS 27.0",
        version: "27.0",
        platform: "iOS",
        supportedDeviceTypes: [
          { name: "iPad Pro 13-inch (M5)", identifier: "pad", productFamily: "iPad" },
          { name: "Apple TV 4K", identifier: "tv", productFamily: "Apple TV" },
          { name: "iPhone 17", identifier: "phone" },
        ],
      },
      { identifier: "x", name: "iOS 28.0", version: "28.0", platform: "iOS", isAvailable: false, supportedDeviceTypes: [{ name: "iPhone 18", identifier: "p18" }] },
      { identifier: "w", name: "watchOS 13.0", version: "13.0", platform: "watchOS", supportedDeviceTypes: [{ name: "Apple Watch", identifier: "w" }] },
    ];
    expect(iosDeviceChoices(runtimes)).toEqual([
      { id: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", version: "27.0", deviceTypes: [{ name: "iPad Pro 13-inch (M5)", family: "iPad" }, { name: "iPhone 17", family: "iPhone" }] },
    ]);
  });
});
