import { describe, expect, it } from "vitest";
import { androidLocale, chooseAvd, parseAvdList, parseEmulatorSerials, parsePhysicalDevices } from "./android";

describe("android 해석", () => {
  it("언어 값 (ADR 0001 발견 2: 설정 언어로 맞춘다)", () => {
    expect(androidLocale("ko_KR")).toBe("ko-KR");
  });

  it("실행 중인 에뮬레이터만 뽑는다", () => {
    const out = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M123\tdevice\n\n";
    expect(parseEmulatorSerials(out)).toEqual(["emulator-5554"]);
  });

  it("adb devices -l 에서 실기기(USB·무선)만 뽑고 모델 이름을 읽는다", () => {
    const out = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
      "R5CT123                device usb:1-1 product:dm1qksx model:SM_S911N device:dm1q transport_id:2",
      "0123ABC                unauthorized usb:1-2 transport_id:3",
      "192.168.0.5:5555       offline transport_id:4",
      "",
    ].join("\n");
    expect(parsePhysicalDevices(out)).toEqual([
      { serial: "R5CT123", state: "device", model: "SM S911N" },
      { serial: "0123ABC", state: "unauthorized", model: null },
      { serial: "192.168.0.5:5555", state: "offline", model: null },
    ]);
    expect(parsePhysicalDevices("List of devices attached\n\n")).toEqual([]);
  });

  it("AVD 목록과 선택", () => {
    const avds = parseAvdList("INFO | something\nPixel_9\nqa_pixel_7_api35\n");
    expect(avds).toEqual(["Pixel_9", "qa_pixel_7_api35"]);
    expect(chooseAvd(avds)).toBe("qa_pixel_7_api35");
    expect(chooseAvd(avds, "Pixel_9")).toBe("Pixel_9");
    expect(chooseAvd(avds, "없는것")).toBeNull();
    expect(chooseAvd([])).toBeNull();
  });
});
