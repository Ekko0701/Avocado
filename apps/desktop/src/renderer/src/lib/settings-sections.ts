import type { AgentUsage, ClaudeConnection, SecretsList, Settings, UpdateStatus } from "@qa/shared";

export const SETTINGS_SECTIONS = [
  { id: "github", label: "GitHub" },
  { id: "claude", label: "Claude" },
  { id: "evidence", label: "증적" },
  { id: "devices", label: "기기" },
  { id: "app", label: "앱 정보" },
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** 구역 목록의 상태 점. on: 준비됨, waiting: 할 일이 남음, off: 문제, api: API 키 방식(비용), null: 상태가 없는 구역 */
export type SectionDot = "on" | "waiting" | "off" | "api" | null;
export interface SectionSummary {
  /** 구역 이름 아래 한 줄(지금 값) */
  hint: string;
  dot: SectionDot;
}

const stored = (secrets: SecretsList, name: string) => secrets.items.some((i) => i.name === name && i.stored);
const usd = (value: number) => `$${value.toFixed(2)}`;

/** 구역마다 지금 상태 한 줄. claude·usage·update 는 아직 못 읽었으면 null 이다 */
export function sectionSummaries(input: {
  settings: Settings;
  secrets: SecretsList;
  claude: ClaudeConnection | null;
  usage: AgentUsage | null;
  update: UpdateStatus | null;
}): Record<SettingsSectionId, SectionSummary> {
  const { settings, secrets, claude, usage, update } = input;
  const g = settings.github;
  const github: SectionSummary = !stored(secrets, "githubToken")
    ? { hint: "토큰을 넣지 않았습니다", dot: "waiting" }
    : !g.owner
      ? { hint: "저장소를 정하지 않았습니다", dot: "waiting" }
      : { hint: `${g.owner}/${g.workspaceRepo}`, dot: "on" };

  let claudeSummary: SectionSummary;
  if (settings.agent.provider === "claude-app") {
    claudeSummary = !claude
      ? { hint: "Claude 앱", dot: null }
      : claude.listening
        ? { hint: `Claude 앱 · 연결된 Claude ${claude.clients.length}개`, dot: claude.clients.length > 0 ? "on" : "waiting" }
        : { hint: "Claude 연결을 열지 못했습니다", dot: "off" };
  } else if (!stored(secrets, "anthropicApiKey")) {
    claudeSummary = { hint: "API 키를 넣지 않았습니다", dot: "waiting" };
  } else {
    claudeSummary = usage
      ? { hint: `API 키 · 이번 달 ${usd(usage.costUsd)} / ${usd(usage.monthlyBudgetUsd)}`, dot: usage.costUsd >= usage.monthlyBudgetUsd ? "off" : "api" }
      : { hint: "API 키", dot: "api" };
  }

  return {
    github,
    claude: claudeSummary,
    evidence: { hint: `${settings.evidence.retentionDays}일 보관 · 업로드 ${settings.policy.evidenceUploadApproved ? "켜짐" : "꺼짐"}`, dot: null },
    devices: { hint: `언어 ${settings.devices.locale}${settings.devices.iosSigningTeam ? ` · iPhone 서명 ${settings.devices.iosSigningTeam}` : ""}`, dot: null },
    app: {
      hint: !update ? "버전 확인 중" : update.available ? `${update.current} · 새 버전 ${update.latest ?? ""}`.trim() : update.latest ? `${update.current} · 최신 버전` : update.current,
      dot: update?.available ? "waiting" : null,
    },
  };
}
