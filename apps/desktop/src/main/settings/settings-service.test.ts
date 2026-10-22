import { DEFAULT_SETTINGS } from "@qa/shared";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretDecryptError, SecretsUnavailableError, SettingsService, type SecretCrypto } from "./settings-service";
import { createTestOnlyCrypto } from "./test-only-crypto";

const SECRET = "sk-ant-THIS-MUST-NEVER-LEAK-0123456789";
const FIXED_NOW = new Date("2026-10-21T07:00:00.000Z");

let dir: string;

function readAllFiles(root: string): string {
  return readdirSync(root)
    .map((name) => readFileSync(join(root, name)).toString("latin1") + readFileSync(join(root, name), "utf8"))
    .join("\n");
}

function makeService(crypto: SecretCrypto = createTestOnlyCrypto()) {
  const service = new SettingsService({ dir, crypto, now: () => FIXED_NOW });
  service.init();
  return service;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("설정", () => {
  it("파일이 없으면 기본값이고, 갱신하면 파일에 남아 다시 읽힌다", () => {
    const service = makeService();
    expect(service.getSettings()).toEqual({ settings: DEFAULT_SETTINGS, issue: null });
    service.updateSettings({ evidence: { retentionDays: 7 }, devices: { locale: "en_US" } });

    const reloaded = makeService();
    expect(reloaded.getSettings().settings.evidence.retentionDays).toBe(7);
    expect(reloaded.getSettings().settings.devices.locale).toBe("en_US");
    expect(reloaded.getSettings().settings.agent).toEqual(DEFAULT_SETTINGS.agent);
  });

  it("잘못된 값은 저장하지 않는다", () => {
    const service = makeService();
    expect(() => service.updateSettings({ evidence: { retentionDays: 999 } })).toThrow();
    expect(makeService().getSettings().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("손상된 설정 파일은 백업하고 기본값으로 시작하며 그 사실을 알린다", () => {
    writeFileSync(join(dir, "settings.json"), "{ not json");
    const service = makeService();
    const state = service.getSettings();
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.issue).toContain("설정 파일이 손상돼");
    expect(readdirSync(dir).some((f) => f.startsWith("settings.json.corrupt-"))).toBe(true);
  });
});

describe("비밀", () => {
  it("평문을 디스크에 남기지 않고, main 에서는 다시 읽을 수 있다", () => {
    const service = makeService();
    const status = service.setSecret("anthropicApiKey", SECRET);
    expect(status).toEqual({ name: "anthropicApiKey", stored: true, updatedAt: FIXED_NOW.toISOString() });
    expect(readAllFiles(dir)).not.toContain(SECRET);
    expect(makeService().getSecret("anthropicApiKey")).toBe(SECRET);
  });

  it("목록과 상태에는 값이 없다", () => {
    const service = makeService();
    service.setSecret("githubToken", SECRET);
    service.setSecret("account:sample:SAMPLE_TEST_STUDENT_PW", SECRET);
    const list = service.listSecrets();
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list.items.map((i) => i.name)).toEqual([
      "anthropicApiKey",
      "githubToken",
      "account:sample:SAMPLE_TEST_STUDENT_PW",
    ]);
    expect(list.items[0]).toEqual({ name: "anthropicApiKey", stored: false, updatedAt: null });
  });

  it("비밀 파일과 설정 파일 권한은 소유자만 읽기·쓰기다", () => {
    const service = makeService();
    service.setSecret("githubToken", SECRET);
    service.updateSettings({ agent: { monthlyBudgetUsd: 10 } });
    for (const name of ["secrets.json", "settings.json"]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("삭제하면 파일에서도 사라진다", () => {
    const service = makeService();
    service.setSecret("githubToken", SECRET);
    expect(service.deleteSecret("githubToken").stored).toBe(false);
    expect(makeService().getSecret("githubToken")).toBeNull();
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("githubToken");
  });

  it("암호화를 쓸 수 없으면 저장을 거부하고 평문으로 대신 쓰지 않는다", () => {
    const unavailable: SecretCrypto = { ...createTestOnlyCrypto(), isAvailable: () => false };
    const service = makeService(unavailable);
    expect(() => service.setSecret("githubToken", SECRET)).toThrow(SecretsUnavailableError);
    expect(service.listSecrets().encryptionAvailable).toBe(false);
    expect(readdirSync(dir)).not.toContain("secrets.json");
  });

  it("잘못된 이름·값을 거부하고, 오류 메시지에 값을 넣지 않는다", () => {
    const service = makeService();
    expect(() => service.setSecret("account:sample:lower" as never, SECRET)).toThrow();
    let message = "";
    try {
      service.setSecret("githubToken", `${SECRET}\n`);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(SECRET);
  });

  it("복호화에 실패하면 이름만 담은 오류를 낸다", () => {
    makeService().setSecret("githubToken", SECRET);
    const broken: SecretCrypto = {
      ...createTestOnlyCrypto(),
      decrypt: () => {
        throw new Error("bad key");
      },
    };
    expect(() => makeService(broken).getSecret("githubToken")).toThrow(SecretDecryptError);
  });

  it("어떤 작업에서도 콘솔에 값을 찍지 않는다", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const service = makeService();
    service.setSecret("anthropicApiKey", SECRET);
    service.listSecrets();
    service.getSecret("anthropicApiKey");
    service.deleteSecret("anthropicApiKey");
    const printed = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(printed).not.toContain(SECRET);
  });
});

describe("테스트 전용 암호화", () => {
  it("평문이 그대로 남지 않고 되돌릴 수 있다", () => {
    const crypto = createTestOnlyCrypto();
    const cipher = crypto.encrypt(SECRET);
    expect(cipher.toString("utf8")).not.toContain(SECRET);
    expect(crypto.decrypt(cipher)).toBe(SECRET);
    expect(() => crypto.decrypt(Buffer.from(SECRET))).toThrow();
  });
});
