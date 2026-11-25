import { describe, expect, it } from "vitest";
import { evidenceLocation, wizardSteps } from "./wizard";

describe("설정 마법사 단계", () => {
  it("GitHub 사용을 끄면 4단계가 첫 앱, 켜면 GitHub·워크스페이스다", () => {
    expect(wizardSteps("local")).toEqual(["Claude 연결", "저장 위치", "환경 점검·도구", "첫 앱", "QA 기기", "완료"]);
    expect(wizardSteps("github")).toEqual(["Claude 연결", "저장 위치", "환경 점검·도구", "GitHub·워크스페이스", "QA 기기", "완료"]);
  });

  it("증적 폴더는 로컬 워크스페이스 옆이다. 그 모양이 아니면 보이지 않는다", () => {
    expect(evidenceLocation("~/Library/Application Support/Avocado/local-workspace")).toBe("~/Library/Application Support/Avocado/evidence");
    expect(evidenceLocation("/tmp/elsewhere")).toBeNull();
  });
});
