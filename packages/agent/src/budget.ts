import { estimateCostUsd, type UsageLike } from "./pricing";

export type AgentMode = "author" | "heal" | "judge";

/** PLAN 6.4 예산과 안전장치 */
export interface BudgetLimits {
  maxToolCalls: number;
  maxToolCallsPerStep: number;
  maxDurationMs: number;
  maxCostUsd: number;
}

export const MODE_LIMITS: Readonly<Record<AgentMode, BudgetLimits>> = {
  author: { maxToolCalls: 300, maxToolCallsPerStep: 15, maxDurationMs: 30 * 60_000, maxCostUsd: 5 },
  heal: { maxToolCalls: 300, maxToolCallsPerStep: 15, maxDurationMs: 10 * 60_000, maxCostUsd: 2 },
  // judge 는 도구 없이 단일 구조화 호출(6.3)
  judge: { maxToolCalls: 0, maxToolCallsPerStep: 0, maxDurationMs: 60_000, maxCostUsd: 0.5 },
};

export type BudgetReason = "tool_calls" | "step_tool_calls" | "time" | "job_cost" | "monthly_cost";

export class BudgetExceededError extends Error {
  constructor(
    readonly reason: BudgetReason,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetSnapshot {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  elapsedMs: number;
}

/**
 * 작업 하나의 예산. 도구 호출 전(beforeToolCall)과 응답을 받은 뒤(addUsage) 검사해 넘으면 BudgetExceededError.
 * 사용자 월 상한은 작업을 시작할 때 남은 금액(monthlyRemainingUsd)으로 넘겨받아 이 작업 비용과 함께 본다.
 *
 * SDK 도구 실행기는 도구가 던진 오류를 모두 is_error 결과로 바꿔 모델에게 돌려준다. 그래서 상한을 넘으면
 * 한 번 기록해 두고(exceeded) signal 을 중단시켜, 실행기에 넘긴 signal 로 진행 중인 요청과 루프를 멈춘다.
 */
export class Budget {
  private toolCalls = 0;
  private stepCalls = 0;
  private readonly started: number;
  private readonly usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tripped: BudgetExceededError | null = null;

  constructor(
    readonly limits: BudgetLimits,
    private readonly options: { monthlyRemainingUsd: number; now?: () => number },
  ) {
    this.started = this.now();
    if (options.monthlyRemainingUsd <= 0) throw new BudgetExceededError("monthly_cost", "이번 달 LLM 비용 상한에 닿았다. 설정에서 상한을 확인한다");
  }

  /** 상한을 넘으면 중단되는 signal. 도구 실행기·API 요청에 넘긴다 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 넘은 상한(없으면 null). 작업 상태를 budget_exceeded 로 기록할 때 쓴다 */
  get exceeded(): BudgetExceededError | null {
    return this.tripped;
  }

  /** 시간 상한에 닿으면 도구 호출이 없어도 중단되게 타이머를 건다. 끝나면 dispose() */
  armTimer(): void {
    // 타이머 콜백에서 던지면 잡을 곳이 없다(main 프로세스 예외). 기록하고 signal 만 끊는다
    this.timer ??= setTimeout(() => {
      this.record(new BudgetExceededError("time", this.timeMessage()));
    }, Math.max(0, this.limits.maxDurationMs - (this.now() - this.started)));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private record(error: BudgetExceededError): BudgetExceededError {
    if (!this.tripped) {
      this.tripped = error;
      this.dispose();
      this.controller.abort(error);
    }
    return this.tripped;
  }

  private trip(error: BudgetExceededError): never {
    throw this.record(error);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private timeMessage(): string {
    const ms = this.limits.maxDurationMs;
    return `작업 시간 상한(${ms >= 60_000 ? `${Math.round(ms / 60_000)}분` : `${Math.round(ms / 1000)}초`})을 넘었다`;
  }

  private checkTime(): void {
    if (this.tripped) throw this.tripped;
    if (this.now() - this.started > this.limits.maxDurationMs) this.trip(new BudgetExceededError("time", this.timeMessage()));
  }

  /** TC 스텝이 바뀔 때 부른다(스텝당 도구 호출 상한) */
  startStep(): void {
    this.stepCalls = 0;
  }

  beforeToolCall(): void {
    this.checkTime();
    if (this.toolCalls >= this.limits.maxToolCalls) this.trip(new BudgetExceededError("tool_calls", `작업당 도구 호출 상한(${this.limits.maxToolCalls})에 닿았다`));
    if (this.stepCalls >= this.limits.maxToolCallsPerStep) {
      this.trip(new BudgetExceededError("step_tool_calls", `스텝당 도구 호출 상한(${this.limits.maxToolCallsPerStep})에 닿았다`));
    }
    this.toolCalls += 1;
    this.stepCalls += 1;
  }

  /**
   * 응답의 usage 를 더한다. 비용 상한을 넘으면 예외(그 응답까지의 비용은 기록된다).
   * model 은 응답한 모델(폴백이면 요청과 다를 수 있다). 단가를 모르면 넉넉히 잡고 estimated 를 돌려준다
   */
  addUsage(model: string, u: UsageLike): { estimated: boolean } {
    this.usage.inputTokens += u.input_tokens;
    this.usage.outputTokens += u.output_tokens;
    this.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    const cost = estimateCostUsd(model, u);
    this.usage.costUsd += cost.usd;
    if (this.usage.costUsd > this.limits.maxCostUsd) {
      this.trip(new BudgetExceededError("job_cost", `작업 비용 상한($${this.limits.maxCostUsd})을 넘었다($${this.usage.costUsd.toFixed(4)})`));
    }
    if (this.usage.costUsd > this.options.monthlyRemainingUsd) this.trip(new BudgetExceededError("monthly_cost", "이번 달 LLM 비용 상한을 넘었다"));
    this.checkTime();
    return { estimated: cost.estimated };
  }

  snapshot(): BudgetSnapshot {
    return { toolCalls: this.toolCalls, ...this.usage, elapsedMs: this.now() - this.started };
  }
}
