/**
 * 모델별 가격(USD / 1M 토큰). claude-api 스킬의 모델 표(2026-10-06 기준)에서 옮겼다.
 * 캐시 쓰기는 입력 단가의 1.25배(5분), 2배(1시간). 모르는 모델은 0원으로 치지 않고 오류를 낸다.
 * 모델을 더할 때는 공식 가격 페이지로 다시 확인한다.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

/** API 응답의 usage 중 비용에 쓰는 필드(BetaUsage 와 같은 이름) */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`가격을 모르는 모델이다: ${model} (packages/agent/src/pricing.ts 에 더한다)`);
    this.name = "UnknownModelPriceError";
  }
}

export function usageCostUsd(model: string, u: UsageLike): number {
  const p = PRICES[model];
  if (!p) throw new UnknownModelPriceError(model);
  const write5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens ?? 0);
  const write1h = u.cache_creation ? u.cache_creation.ephemeral_1h_input_tokens : 0;
  const usd =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    write5m * p.input * 1.25 +
    write1h * p.input * 2;
  return usd / 1_000_000;
}

/**
 * 서버 측 폴백(fallbacks: "default")으로 다른 모델이 응답하면 그 모델 단가를 모를 수 있다.
 * 그때는 표에서 가장 비싼 단가로 넉넉히 잡아 예산이 새지 않게 하고 estimated 로 알린다.
 */
export function estimateCostUsd(model: string, u: UsageLike): { usd: number; estimated: boolean } {
  if (PRICES[model]) return { usd: usageCostUsd(model, u), estimated: false };
  const priciest = Object.entries(PRICES).reduce((a, b) => (b[1].output > a[1].output ? b : a));
  return { usd: usageCostUsd(priciest[0], u), estimated: true };
}
