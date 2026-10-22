import { describe, expect, it } from "vitest";
import { judgeMetrics, metricsMarkdown } from "./metrics";

describe("judge 정밀도 계산", () => {
  it("결함을 양성으로 정밀도·재현율·혼동 행렬, 불확실은 따로", () => {
    const m = judgeMetrics([
      { id: "a", label: "fail", predicted: "fail", costUsd: 0.01 },
      { id: "b", label: "pass", predicted: "fail", costUsd: 0.01 },
      { id: "c", label: "pass", predicted: "pass", costUsd: 0.01 },
      { id: "d", label: "fail", predicted: "pass", costUsd: 0.01 },
      { id: "e", label: "fail", predicted: "uncertain", costUsd: 0.01 },
    ]);
    expect(m).toMatchObject({ total: 5, precision: 0.5, recall: 0.5, uncertain: 1, confusion: { tp: 1, fp: 1, tn: 1, fn: 1 }, misjudged: ["b", "d"] });
    expect(m.costUsd).toBeCloseTo(0.05, 9);
    expect(metricsMarkdown(m, { model: "claude-opus-5-5", date: "2026-10-22", dataset: "x" })).toContain("정밀도(결함 판정 중 실제 결함): **50.0%**");
    expect(judgeMetrics([]).precision).toBeNull();
  });
});
