import { DEFAULT_SETTINGS, type AgentUsage, type ClaudeConnection, type SecretsList, type Settings, type UpdateStatus } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { sectionSummaries } from "./settings-sections";

const secrets = (...names: string[]): SecretsList => ({
  encryptionAvailable: true,
  items: ["anthropicApiKey", "githubToken"].map((name) => ({ name, stored: names.includes(name), updatedAt: null })),
});
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const claude = (over: Partial<ClaudeConnection> = {}): ClaudeConnection => ({
  listening: true,
  socketPath: "/tmp/avocado.sock",
  error: null,
  clients: [],
  desktop: { configPath: "/tmp/claude.json", state: "configured" },
  codeCommand: "claude mcp add-json",
  ...over,
});
const usage = (costUsd: number, monthlyBudgetUsd = 100): AgentUsage => ({ month: "2026-11", costUsd, monthlyBudgetUsd, jobs: 1, byType: [], recent: [] });
const update = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ current: "0.1.18", source: "acme/app", latest: null, available: false, checkedAt: null, release: null, asset: null, error: null, downloaded: null, ...over }) as UpdateStatus;
const none = { claude: null, usage: null, update: null, source: "github" as const, cli: null };

describe("설정 구역 요약", () => {
  it("GitHub: 토큰 → 저장소 순으로 남은 일을 알리고, 다 되면 저장소 이름", () => {
    const g = DEFAULT_SETTINGS.github;
    expect(sectionSummaries({ settings: settings(), secrets: secrets(), ...none }).github).toEqual({ hint: "토큰을 넣지 않았습니다", dot: "waiting" });
    expect(sectionSummaries({ settings: settings({ github: { ...g, owner: null } }), secrets: secrets("githubToken"), ...none }).github).toEqual({ hint: "저장소를 정하지 않았습니다", dot: "waiting" });
    expect(sectionSummaries({ settings: settings({ github: { ...g, owner: "acme", workspaceRepo: "qa-workspace" } }), secrets: secrets("githubToken"), ...none }).github).toEqual({
      hint: "acme/qa-workspace",
      dot: "on",
    });
  });

  it("Claude 앱 방식: 연결 상태와 연결된 Claude 수", () => {
    const s = settings();
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none }).claude).toEqual({ hint: "Claude 앱", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, claude: claude() }).claude).toEqual({ hint: "Claude 앱 · 연결된 Claude 0개", dot: "waiting" });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, claude: claude({ clients: [{ name: "claude-desktop", version: "1.4", connectedAt: "2026-11-10T01:00:00.000Z" }] }) }).claude).toEqual({
      hint: "Claude 앱 · 연결된 Claude 1개",
      dot: "on",
    });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, claude: claude({ listening: false, error: "다른 Avocado 가 쓰고 있다" }) }).claude).toEqual({
      hint: "Claude 연결을 열지 못했습니다",
      dot: "off",
    });
  });

  it("API 키 방식: 키가 없으면 알리고, 있으면 이번 달 비용. 상한에 닿으면 문제로 표시", () => {
    const s = settings({ agent: { ...DEFAULT_SETTINGS.agent, provider: "api" } });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none }).claude).toEqual({ hint: "API 키를 넣지 않았습니다", dot: "waiting" });
    expect(sectionSummaries({ settings: s, secrets: secrets("anthropicApiKey"), ...none }).claude).toEqual({ hint: "API 키", dot: "api" });
    expect(sectionSummaries({ settings: s, secrets: secrets("anthropicApiKey"), ...none, usage: usage(12.4) }).claude).toEqual({ hint: "API 키 · 이번 달 $12.40 / $100.00", dot: "api" });
    expect(sectionSummaries({ settings: s, secrets: secrets("anthropicApiKey"), ...none, usage: usage(100) }).claude.dot).toBe("off");
  });

  it("증적·기기·앱 정보는 지금 값을 보인다", () => {
    const s = settings({ evidence: { retentionDays: 14 }, policy: { evidenceUploadApproved: true }, devices: { locale: "en_US", iosSigningTeam: null } });
    const out = sectionSummaries({ settings: s, secrets: secrets(), ...none });
    expect(out.evidence).toEqual({ hint: "14일 보관 · 업로드 켜짐", dot: null });
    expect(out.devices).toEqual({ hint: "언어 en_US", dot: null });
    expect(out.app).toEqual({ hint: "버전 확인 중", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, update: update() }).app).toEqual({ hint: "0.1.18", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, update: update({ latest: "v0.1.18" }) }).app).toEqual({ hint: "0.1.18 · 최신 버전", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, update: update({ latest: "v0.2.0", available: true }) }).app).toEqual({ hint: "0.1.18 · 새 버전 v0.2.0", dot: "waiting" });
  });

  it("로컬 워크스페이스: GitHub 는 할 일이 아니고 증적은 올리기를 말하지 않는다", () => {
    const s = settings({ evidence: { retentionDays: 30 }, policy: { evidenceUploadApproved: true } });
    const out = sectionSummaries({ settings: s, secrets: secrets(), ...none, source: "local" });
    expect(out.github).toEqual({ hint: "쓰지 않음 · 로컬 워크스페이스", dot: null });
    expect(out.evidence).toEqual({ hint: "30일 보관", dot: null });
  });

  it("터미널: 개발 실행은 pnpm avocado, 패키징한 앱은 연결 여부", () => {
    const base = { available: true, scriptPath: "/Applications/Avocado.app/Contents/Resources/bin/avocado", linkPath: "~/.local/bin/avocado", linkCommand: "ln -sf …" };
    const s = settings();
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none }).terminal).toEqual({ hint: "avocado 명령", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, cli: { ...base, available: false, scriptPath: null, linkCommand: null, link: "none" } }).terminal).toEqual({ hint: "개발 실행 · pnpm avocado", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, cli: { ...base, link: "other" } }).terminal).toEqual({ hint: "avocado 명령 · 연결 전", dot: null });
    expect(sectionSummaries({ settings: s, secrets: secrets(), ...none, cli: { ...base, link: "this" } }).terminal).toEqual({ hint: "avocado 명령 · 연결됨", dot: "on" });
  });
});
