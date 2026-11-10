import { describe, expect, it } from "vitest";
import { androidLocale, chooseAvd, parseAvdList, parseEmulatorSerials, parseRealSerials } from "./android";

describe("android 해석", () => {
  it("언어 값 (ADR 0001 발견 2: 설정 언어로 맞춘다)", () => {
    expect(androidLocale("ko_KR")).toBe("ko-KR");
  });

  it("실행 중인 에뮬레이터만 뽑는다", () => {
    const out = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M123\tdevice\n\n";
    expect(parseEmulatorSerials(out)).toEqual(["emulator-5554"]);
  });

  it("연결된 실기기만 뽑는다(에뮬레이터·승인 전·오프라인 제외)", () => {
    const out = "List of devices attached\nemulator-5554\tdevice\nR58M123\tdevice\nR3CN456\tunauthorized\nR54T789\toffline\n\n";
    expect(parseRealSerials(out)).toEqual(["R58M123"]);
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
