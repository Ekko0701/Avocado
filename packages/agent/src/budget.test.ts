import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, BudgetExceededError, MODE_LIMITS } from "./budget";

const limits = { maxToolCalls: 3, maxToolCallsPerStep: 2, maxDurationMs: 1000, maxCostUsd: 1 };
const usage = (input: number, output = 0) => ({ input_tokens: input, output_tokens: output });

function reasonOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BudgetExceededError) return error.reason;
    throw error;
  }
  return "none";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Budget", () => {
  it("PLAN 6.4 기본 상한", () => {
    expect(MODE_LIMITS.author).toMatchObject({ maxToolCalls: 300, maxToolCallsPerStep: 15, maxDurationMs: 1_800_000, maxCostUsd: 5 });
    expect(MODE_LIMITS.heal.maxDurationMs).toBe(600_000);
    expect(MODE_LIMITS.judge.maxToolCalls).toBe(0);
  });

  it("스텝당 상한은 startStep 으로 다시 센다", () => {
    const b = new Budget(limits, { monthlyRemainingUsd: 10 });
    b.beforeToolCall();
    b.beforeToolCall();
    b.startStep();
    b.beforeToolCall();
    expect(b.snapshot().toolCalls).toBe(3);
    expect(reasonOf(() => b.beforeToolCall())).toBe("tool_calls");
  });

  it("스텝당 상한을 넘으면 중단되고 signal 이 끊긴다. 이후 호출도 같은 이유로 막힌다", () => {
    const b = new Budget(limits, { monthlyRemainingUsd: 10 });
    b.beforeToolCall();
    b.beforeToolCall();
    expect(reasonOf(() => b.beforeToolCall())).toBe("step_tool_calls");
    expect(b.signal.aborted).toBe(true);
    expect(b.exceeded?.reason).toBe("step_tool_calls");
    b.startStep();
    expect(reasonOf(() => b.beforeToolCall())).toBe("step_tool_calls");
  });

  it("비용: 작업 상한과 이번 달 남은 금액 중 먼저 닿는 쪽", () => {
    const b = new Budget(limits, { monthlyRemainingUsd: 10 });
    b.addUsage("claude-opus-5-5", usage(200_000)); // $0.8
    expect(b.snapshot().costUsd).toBeCloseTo(0.8, 6);
    expect(reasonOf(() => b.addUsage("claude-opus-5-5", usage(100_000)))).toBe("job_cost");

    const m = new Budget(limits, { monthlyRemainingUsd: 0.5 });
    expect(reasonOf(() => m.addUsage("claude-opus-5-5", usage(200_000)))).toBe("monthly_cost");
    // 그 응답까지의 사용량은 남는다(agent_job 에 기록)
    expect(m.snapshot().inputTokens).toBe(200_000);
  });

  it("이번 달 남은 금액이 없으면 시작하지 않는다", () => {
    expect(() => new Budget(limits, { monthlyRemainingUsd: 0 })).toThrow(BudgetExceededError);
  });

  it("시간: 도구 호출 때 검사하고, 타이머로도 끊는다", () => {
    let t = 0;
    const b = new Budget(limits, { monthlyRemainingUsd: 10, now: () => t });
    t = 1001;
    expect(reasonOf(() => b.beforeToolCall())).toBe("time");

    vi.useFakeTimers();
    const c = new Budget(limits, { monthlyRemainingUsd: 10 });
    c.armTimer();
    vi.advanceTimersByTime(1001);
    expect(c.signal.aborted).toBe(true);
    expect(c.exceeded?.reason).toBe("time");
  });
});
