import type { RunDetail, RunSummary } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { attention, dailyCounts, elapsed, localDay, runProgress } from "./dashboard";

const NOW = new Date("2026-11-10T12:00:00");
let n = 0;
const run = (over: Partial<RunSummary> & { createdAt: string }): RunSummary => ({
  id: `run-${++n}`,
  status: "passed",
  app: "demo",
  flowName: "TC-0101 가입",
  flowPath: "x",
  tcId: "TC-0101",
  target: "ios",
  deviceId: "d",
  deviceName: "iPhone",
  buildId: null,
  buildLabel: null,
  attempts: 1,
  flaky: false,
  failureMessage: null,
  kept: false,
  evidenceRemoved: false,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const at = (local: string) => new Date(local).toISOString();

describe("대시보드 계산", () => {
  const runs = [
    run({ createdAt: at("2026-11-10T10:00:00"), status: "failed" }),
    run({ createdAt: at("2026-11-10T09:00:00"), status: "failed" }),
    run({ createdAt: at("2026-11-09T09:00:00"), status: "passed" }),
    run({ createdAt: at("2026-11-09T08:00:00"), target: "android", status: "passed", flaky: true }),
    run({ createdAt: at("2026-11-08T08:00:00"), tcId: "TC-0002", status: "error" }),
    run({ createdAt: at("2026-11-08T07:00:00"), tcId: "TC-0003", status: "canceled" }),
    run({ createdAt: at("2026-11-10T11:00:00"), tcId: "TC-0004", status: "running" }),
    // 7일 밖
    run({ createdAt: at("2026-11-01T09:00:00"), tcId: "TC-0005", status: "passed" }),
  ];

  it("날마다 통과·실패(오류 포함) 수를 오늘까지 14일로 나눈다(현지 날짜)", () => {
    const days = dailyCounts(runs, NOW);
    expect(days).toHaveLength(14);
    expect(days.at(-1)).toEqual({ day: "2026-11-10", passed: 0, failed: 2 });
    expect(days.at(-2)).toEqual({ day: "2026-11-09", passed: 2, failed: 0 });
    expect(days.at(-3)).toEqual({ day: "2026-11-08", passed: 0, failed: 1 });
    expect(days.find((d) => d.day === "2026-11-01")).toEqual({ day: "2026-11-01", passed: 1, failed: 0 });
    expect(days[0]?.day).toBe("2026-10-28");
    expect(localDay(new Date("2026-01-05T23:59:00"))).toBe("2026-01-05");
  });

  it("살펴볼 테스트 케이스: 테스트 케이스·타깃의 마지막 결과가 실패이거나 재시도 통과. 실패가 먼저이고 연속 실패 수를 센다", () => {
    const items = attention(runs);
    expect(items.map((i) => [i.tcId, i.target, i.latest.status, i.streak])).toEqual([
      ["TC-0101", "ios", "failed", 2],
      ["TC-0002", "ios", "error", 1],
      ["TC-0101", "android", "passed", 0],
    ]);
    // 마지막이 통과면 앞의 실패는 지나간 일이다
    expect(attention([run({ createdAt: at("2026-11-10T10:00:00") }), run({ createdAt: at("2026-11-09T10:00:00"), status: "failed" })])).toEqual([]);
  });

  it("재생 중 진행: 마지막 회차의 끝난 스텝 수와 지금 스텝. 스텝이 아직 없으면 null", () => {
    const step = (index: number, status: RunDetail["executions"][number]["steps"][number]["status"]) => ({
      index,
      command: "tapOn",
      description: `step ${index}`,
      status,
      durationMs: null,
      error: null,
      screenshot: null,
      failureScreenshot: null,
      hierarchy: null,
    });
    const exec = (attempt: number, steps: ReturnType<typeof step>[]) => ({
      id: `e${attempt}`,
      attempt,
      status: "running" as const,
      durationMs: null,
      failureClass: null,
      failure: null,
      hostLoad: null,
      startedAt: null,
      finishedAt: null,
      warnings: [],
      steps,
    });
    const base = { ...run({ createdAt: at("2026-11-10T10:00:00"), status: "running" }) };
    expect(runProgress({ ...base, executions: [exec(1, [step(0, "completed"), step(1, "completed"), step(2, "running"), step(3, "pending")])] } as RunDetail)).toEqual({
      done: 2,
      total: 4,
      current: "step 2",
      attempt: 1,
    });
    expect(runProgress({ ...base, executions: [exec(1, [step(0, "failed")]), exec(2, [])] } as RunDetail)).toBeNull();
    expect(runProgress({ ...base, executions: [] } as RunDetail)).toBeNull();
  });

  it("경과 시간", () => {
    expect(elapsed(new Date(NOW.getTime() - 42_000).toISOString(), NOW)).toBe("42초");
    expect(elapsed(new Date(NOW.getTime() - 130_000).toISOString(), NOW)).toBe("2분 10초");
    expect(elapsed(null, NOW)).toBe("시작 전");
  });
});
