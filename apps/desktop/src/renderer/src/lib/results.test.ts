import type { RunSummary } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { durationText, filterCounts, filterRuns, latestMatrix, runTitle } from "./results";

let n = 0;
const run = (over: Partial<RunSummary>): RunSummary => ({
  id: `run-${++n}`,
  status: "passed",
  app: "demo",
  flowName: "TC-0101 가입",
  flowPath: "x",
  tcId: "TC-0101",
  target: "ios",
  deviceId: "d",
  deviceName: "iPhone 17",
  buildId: null,
  buildLabel: null,
  attempts: 1,
  flaky: false,
  failureMessage: null,
  kept: false,
  evidenceRemoved: false,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-11-10T01:00:00.000Z",
  ...over,
});

describe("결과 화면 목록", () => {
  const runs = [
    run({ id: "a", status: "failed" }),
    run({ id: "b", target: "android", deviceName: "Pixel 7" }),
    run({ id: "c", tcId: "TC-0002", flowName: "로그인", status: "error" }),
    run({ id: "d", status: "canceled" }),
    run({ id: "e", tcId: "TC-0002", flowName: "로그인", target: "android", deviceName: "Pixel 7" }),
  ];

  it("상태 칩 수: 실패는 오류를 포함하고, 취소는 전체에만 센다", () => {
    expect(filterCounts(runs)).toEqual({ all: 5, failed: 2, passed: 2 });
  });

  it("칩과 검색어(ID·이름·기기·타깃, 대소문자 무시, 낱말마다)로 거른다", () => {
    expect(filterRuns(runs, "failed", "").map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterRuns(runs, "passed", "").map((r) => r.id)).toEqual(["b", "e"]);
    expect(filterRuns(runs, "all", "pixel").map((r) => r.id)).toEqual(["b", "e"]);
    expect(filterRuns(runs, "all", "tc-0002 ANDROID").map((r) => r.id)).toEqual(["e"]);
    expect(filterRuns(runs, "failed", "로그인").map((r) => r.id)).toEqual(["c"]);
    expect(filterRuns(runs, "all", "  ").length).toBe(5);
  });

  it("테스트 케이스·타깃마다 가장 최근 실행", () => {
    expect(latestMatrix(runs).map((r) => [r.tcId, r.title, r.ios?.id, r.android?.id])).toEqual([
      ["TC-0101", "가입", "a", "b"],
      ["TC-0002", "로그인", "c", "e"],
    ]);
  });

  it("제목과 걸린 시간", () => {
    expect(runTitle({ tcId: "TC-0101", flowName: "TC-0101 가입" })).toBe("TC-0101 가입");
    expect(runTitle({ tcId: "TC-0002", flowName: "로그인" })).toBe("TC-0002 · 로그인");
    expect(durationText(null)).toBe("");
    expect(durationText(820)).toBe("0.8초");
    expect(durationText(48_200)).toBe("48초");
    expect(durationText(82_000)).toBe("1분 22초");
  });
});
