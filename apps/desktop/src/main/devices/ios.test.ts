import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appleLocaleValues, findDeviceByName, iosVersionFromRuntimeId, NoRuntimeError, pickRuntime, type SimRuntime } from "./ios";

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

  it("이름으로 사용 가능한 기기만 찾는다", () => {
    const devices = {
      "rt-a": [{ udid: "1", name: "QA Tool iPhone 17", state: "Shutdown", isAvailable: false }],
      "rt-b": [{ udid: "2", name: "QA Tool iPhone 17", state: "Booted", isAvailable: true }],
    };
    expect(findDeviceByName(devices, "QA Tool iPhone 17")).toEqual({ device: devices["rt-b"][0], runtimeId: "rt-b" });
    expect(findDeviceByName(devices, "없음")).toBeNull();
  });
});
