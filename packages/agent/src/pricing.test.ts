import { describe, expect, it } from "vitest";
import { UnknownModelPriceError, usageCostUsd } from "./pricing";

describe("usageCostUsd", () => {
  it("입력·출력·캐시 읽기·캐시 쓰기(5분/1시간)를 모두 더한다", () => {
    const cost = usageCostUsd("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 2_000_000,
      cache_creation_input_tokens: 300_000,
      cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 100_000 },
    });
    // 4 + 2 + 0.4 + 0.2*4*1.25 + 0.1*4*2
    expect(cost).toBeCloseTo(4 + 2 + 0.4 + 1 + 0.8, 6);
  });

  it("cache_creation 내역이 없으면 캐시 쓰기를 5분 단가로 본다", () => {
    const cost = usageCostUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(2.5, 6);
  });

  it("모르는 모델은 0원으로 치지 않고 오류", () => {
    expect(() => usageCostUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 })).toThrow(UnknownModelPriceError);
  });
});
