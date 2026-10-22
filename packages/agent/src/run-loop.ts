import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";
import type { AuditLog } from "./audit";
import type { Budget } from "./budget";
import { estimateCostUsd } from "./pricing";
import { SCREEN_DATA_NOTICE } from "./screen-data";

export const DEFAULT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** 모델이 응답을 거절했다(stop_reason "refusal"). 재시도하지 않고 사람에게 보여 준다 */
export class AgentRefusalError extends Error {
  constructor(readonly text: string) {
    super(`모델이 응답을 거절했다${text ? `: ${text.slice(0, 200)}` : ""}`);
    this.name = "AgentRefusalError";
  }
}

export interface ToolLoopOptions {
  client: Anthropic;
  model?: string;
  /** 항상 명시한다(CLAUDE.md 8장). thinking·budget_tokens 는 보내지 않는다 */
  effort: Effort;
  system: string;
  messages: BetaMessageParam[];
  // 도구마다 입력 타입이 달라 SDK 의 toolRunner 처럼 any 로 받는다
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: BetaRunnableTool<any>[];
  budget: Budget;
  audit: AuditLog;
  maxTokens: number;
  /** API 요청 수 상한(도구 호출 상한과 별개로 루프가 끝없이 돌지 않게) */
  maxIterations?: number;
  /** 사용자 취소. 예산 signal 과 함께 실행기·도구 호출에 넘긴다 */
  signal?: AbortSignal;
  /** 응답마다(사용량을 더한 뒤) 부른다. 작업 기록·진행 표시용 */
  onMessage?: (message: BetaMessage) => void;
}

export interface ToolLoopResult {
  final: BetaMessage;
  iterations: number;
}

/**
 * SDK 도구 실행기(toolRunner)로 에이전트 루프를 돈다(PLAN 6.2).
 * 응답마다 usage 를 예산·감사 기록에 더하고, 거절은 AgentRefusalError, 예산 초과는 BudgetExceededError 로 끝낸다.
 * 시스템 프롬프트 끝에 화면 데이터 안내(SCREEN_DATA_NOTICE)를 항상 붙인다.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const { budget, audit } = options;
  const runner = options.client.beta.messages.toolRunner(
    {
      model,
      max_tokens: options.maxTokens,
      // 시스템 프롬프트는 작업마다 같으므로 캐시 프리픽스로 둔다(PLAN 8장)
      system: [{ type: "text", text: `${options.system}\n\n${SCREEN_DATA_NOTICE}`, cache_control: { type: "ephemeral" } }],
      // 실행기는 대화 뒤에 응답·도구 결과만 붙인다. 마지막 블록까지 자동 캐시해 다음 요청이 앞 대화를
      // 캐시 읽기(입력 단가의 0.05배)로 받게 한다(D8, ADR 0021). 턴 간격이 5분보다 짧아 TTL 은 기본 5분
      cache_control: { type: "ephemeral" },
      messages: options.messages,
      tools: options.tools,
      output_config: { effort: options.effort },
      // 안전 분류기가 거절하면 서버가 권장 모델로 다시 돌린다(PLAN 8장). 그래도 거절이면 refusal 로 온다
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      max_iterations: options.maxIterations ?? 200,
    },
    { signal: options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal },
  );
  let final: BetaMessage | undefined;
  let iterations = 0;
  try {
    for await (const message of runner) {
      iterations += 1;
      final = message;
      // 폴백이면 응답한 모델(message.model)이 요청 모델과 다르다. 비용은 응답한 모델 기준
      // 상한을 넘어 addUsage 가 던져도 그 응답의 사용량은 감사 기록에 남긴다
      audit.write({
        kind: "model_usage",
        model: message.model,
        requested: model,
        priceEstimated: estimateCostUsd(message.model, message.usage).estimated,
        stopReason: message.stop_reason,
        usage: message.usage,
      });
      budget.addUsage(message.model, message.usage);
      options.onMessage?.(message);
      if (message.stop_reason === "refusal") {
        const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
        throw new AgentRefusalError(text);
      }
    }
  } catch (error) {
    // 예산 초과로 signal 을 끊으면 SDK 는 중단 오류를 던진다. 원인(예산)으로 바꿔 알린다
    if (budget.exceeded) {
      audit.write({ kind: "budget_exceeded", reason: budget.exceeded.reason, message: budget.exceeded.message });
      throw budget.exceeded;
    }
    throw error;
  }
  if (!final) throw new Error("모델 응답이 없다");
  return { final, iterations };
}
