import { describe, expect, it } from "vitest";
import {
  APP_SECRET_NAMES,
  applySettingsPatch,
  DEFAULT_SETTINGS,
  evidencePrefixOf,
  SecretNameSchema,
  SecretStatusSchema,
  SecretValueSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from "./settings";

describe("Settings", () => {
  it("기본값은 스키마를 통과한다", () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("패치는 바꾼 필드만 바꾸고 나머지는 유지한다", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { agent: { monthlyBudgetUsd: 50 } });
    expect(next.agent).toEqual({ monthlyBudgetUsd: 50, judgeSampleRate: 0, provider: "claude-app" });
    expect(next.evidence).toEqual(DEFAULT_SETTINGS.evidence);
  });

  it("LLM 방식(provider)이 없는 이전 설정은 Claude 앱 방식으로 읽고, 다른 필드 패치가 고른 방식을 되돌리지 않는다(D17)", () => {
    const legacy = { ...DEFAULT_SETTINGS, agent: { monthlyBudgetUsd: 1, judgeSampleRate: 0 } };
    expect(SettingsSchema.parse(legacy).agent.provider).toBe("claude-app");
    const api = applySettingsPatch(DEFAULT_SETTINGS, { agent: { provider: "api" } });
    expect(api.agent.provider).toBe("api");
    expect(applySettingsPatch(api, { agent: { monthlyBudgetUsd: 5 } }).agent).toEqual({ monthlyBudgetUsd: 5, judgeSampleRate: 0, provider: "api" });
    expect(SettingsPatchSchema.safeParse({ agent: { provider: "openai" } }).success).toBe(false);
  });

  it("연도로 끝나는 증적 저장소 이름에서 접두사를 뽑는다(목록에서 고르기)", () => {
    expect(evidencePrefixOf("Avocado-qa-evidence-2026")).toEqual({ prefix: "Avocado-qa-evidence-", year: 2026 });
    expect(evidencePrefixOf("qa-evidence2027")).toEqual({ prefix: "qa-evidence", year: 2027 });
    expect(evidencePrefixOf("Avocado-qa-evidence")).toBeNull();
    expect(evidencePrefixOf("2026")).toBeNull();
  });

  it("setup 필드가 없는 이전 버전 설정도 그대로 읽고, 패치로는 setup 을 바꿀 수 없다", () => {
    const legacy = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => key !== "setup"));
    const parsed = SettingsSchema.parse(legacy);
    expect(parsed.setup).toEqual({ completedAt: null });
    expect(SettingsPatchSchema.safeParse({ setup: { completedAt: "2026-10-21T00:00:00.000Z" } }).success).toBe(false);
  });

  it("범위를 벗어나거나 모르는 필드가 있는 패치를 거부한다", () => {
    expect(SettingsPatchSchema.safeParse({ evidence: { retentionDays: 0 } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ agent: { judgeSampleRate: 1.5 } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ devices: { locale: "korean" } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ unknown: {} }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ policy: { evidenceUploadApproved: true, extra: 1 } }).success).toBe(false);
  });
});

describe("비밀 이름과 값", () => {
  it("앱 비밀과 계정 비밀 이름을 허용한다", () => {
    for (const name of [...APP_SECRET_NAMES, "account:sample:SAMPLE_TEST_STUDENT_PW"]) {
      expect(SecretNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("형식이 다른 이름을 거부한다", () => {
    for (const name of ["openaiKey", "account:Sample:KEY", "account:sample:lower", "account::KEY", "../secrets", ""]) {
      expect(SecretNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("빈 값과 제어 문자를 거부한다", () => {
    expect(SecretValueSchema.safeParse("sk-test").success).toBe(true);
    expect(SecretValueSchema.safeParse("").success).toBe(false);
    expect(SecretValueSchema.safeParse("token\n").success).toBe(false);
    expect(SecretValueSchema.safeParse("x".repeat(4097)).success).toBe(false);
  });

  it("비밀 상태에는 값 필드가 없고, 값을 넣으면 거부한다", () => {
    expect(Object.keys(SecretStatusSchema.shape).sort()).toEqual(["name", "stored", "updatedAt"]);
    expect(
      SecretStatusSchema.safeParse({ name: "githubToken", stored: true, updatedAt: null, value: "x" }).success,
    ).toBe(false);
  });
});
