import { z } from "zod";

/**
 * 앱 설정(비밀 아님)과 비밀의 스키마 (PLAN 10.3, 12장 "설정").
 * - 설정은 userData/settings.json 에 평문 JSON 으로 저장한다.
 * - 비밀 값은 safeStorage 로 암호화해 userData/secrets.json 에 저장한다.
 * - 비밀 값은 main 밖으로 나가지 않는다. 렌더러는 SecretStatus 만 받는다.
 */

export const LocaleSchema = z.string().regex(/^[a-z]{2}_[A-Z]{2}$/, "언어는 ko_KR 형식");
/** GitHub 조직·사용자 이름과 저장소 이름 (PLAN 10.1, D5) */
export const GitHubOwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "GitHub 조직 이름 형식이 아니다");
export const RepoNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, "저장소 이름 형식이 아니다");
export const GitHubSettingsSchema = z.strictObject({
  /** 워크스페이스·증적 저장소의 주인(GitHub 개인 계정 또는 조직). 정하기 전(null)에는 GitHub 기능을 쓰지 않는다 */
  owner: GitHubOwnerSchema.nullable(),
  workspaceRepo: RepoNameSchema,
  /** 연도별 증적 저장소 접두사. 예: qa-evidence- → qa-evidence-2026 (PLAN 9.4) */
  evidenceRepoPrefix: z.string().regex(/^[A-Za-z0-9_.-]{1,90}$/, "저장소 이름 형식이 아니다"),
});
export type GitHubSettings = z.infer<typeof GitHubSettingsSchema>;
/**
 * 연도로 끝나는 증적 저장소 이름에서 접두사와 연도를 뽑는다(예: Avocado-qa-evidence-2026 → Avocado-qa-evidence-, 2026).
 * 앱은 접두사 + 올해로 저장소를 찾는다(PLAN 9.4). 연도로 끝나지 않으면 null
 */
export function evidencePrefixOf(repo: string): { prefix: string; year: number } | null {
  const m = /^(.+?)(\d{4})$/.exec(repo);
  if (!m?.[1] || !m[2]) return null;
  const prefix = GitHubSettingsSchema.shape.evidenceRepoPrefix.safeParse(m[1]);
  return prefix.success ? { prefix: prefix.data, year: Number(m[2]) } : null;
}

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = { owner: null, workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-" };

/**
 * 예전 settings.json 의 github.appRepo(새 버전을 확인하던 저장소)는 읽을 때 버린다.
 * 새 버전은 워크스페이스 조직과 상관없이 배포 저장소에서 확인한다(desktop update/trust.ts). 버리지 않으면 예전 파일이 손상으로 처리된다
 */
function withoutLegacyAppRepo(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !("appRepo" in value)) return value;
  const rest: Record<string, unknown> = { ...value };
  delete rest.appRepo;
  return rest;
}

/** 이 Mac 에 연결한 프로젝트 폴더(앱마다). 경로는 사람마다 달라 워크스페이스가 아니라 각자 설정에 둔다(ADR 0025) */
export const ProjectLinkSchema = z.strictObject({
  path: z.string().min(1),
  /** 이 Mac 에서 마지막으로 고른 스킴·구성 */
  scheme: z.string().nullable(),
  configuration: z.string().nullable(),
});
export type ProjectLink = z.infer<typeof ProjectLinkSchema>;

export const AgentProviderSchema = z.enum(["claude-app", "api"]);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const SettingsSchema = z.strictObject({
  version: z.literal(1),
  evidence: z.strictObject({
    /** 로컬 증적 보관 일수 (PLAN 9.1) */
    retentionDays: z.number().int().min(1).max(365),
  }),
  agent: z.strictObject({
    /** 사용자별 월 LLM 비용 상한, USD (PLAN 6.4) */
    monthlyBudgetUsd: z.number().min(0).max(10_000),
    /** 통과 실행에서 judge 로 판정할 캡처 비율 (PLAN 6.7) */
    judgeSampleRate: z.number().min(0).max(1),
    /**
     * 플로우 만들기를 누구의 Claude 로 하나(D17, ADR 0022). claude-app: 각자의 Claude 앱에 MCP 로 연결(그 요금제·한도),
     * api: 앱이 Anthropic API 키로 직접 부른다. 기본값을 둬서 이전 settings.json 도 그대로 읽힌다
     */
    provider: AgentProviderSchema.default("claude-app"),
  }),
  devices: z.strictObject({
    /** QA 기기 언어 (ADR 0001 발견 2) */
    locale: LocaleSchema,
  }),
  policy: z.strictObject({
    /** 외부 GitHub 증적 업로드에 대한 조직 보안 승인 (D11). 꺼져 있으면 업로드 기능을 숨긴다. */
    evidenceUploadApproved: z.boolean(),
  }),
  /**
   * 설정 마법사 완료 시각. T-103 에서 추가했다.
   * 기본값을 둬서 이전 버전이 만든 settings.json 도 손상 파일로 처리되지 않는다.
   * 렌더러의 settings:update 로는 바꿀 수 없고 setup:complete 로만 바꾼다.
   */
  setup: z.strictObject({ completedAt: z.iso.datetime().nullable() }).default({ completedAt: null }),
  /** GitHub 연동(T-109). 기본값을 둬서 이전 settings.json 도 그대로 읽힌다 */
  github: z.preprocess(withoutLegacyAppRepo, GitHubSettingsSchema).default(DEFAULT_GITHUB_SETTINGS),
  /** 앱 → 플랫폼별 프로젝트 연결. 렌더러의 settings:update 로는 바꾸지 못하고 빌드 화면의 연결로만 바꾼다 */
  projects: z.record(z.string(), z.strictObject({ ios: ProjectLinkSchema.optional() })).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  evidence: { retentionDays: 30 },
  // 자동 화면 판정은 기본 끔(D15, ADR 0021). 결과 화면의 버튼으로 돈다
  agent: { monthlyBudgetUsd: 100, judgeSampleRate: 0, provider: "claude-app" },
  devices: { locale: "ko_KR" },
  policy: { evidenceUploadApproved: false },
  setup: { completedAt: null },
  github: DEFAULT_GITHUB_SETTINGS,
  projects: {},
};

export const SettingsPatchSchema = z.strictObject({
  evidence: SettingsSchema.shape.evidence.partial().optional(),
  agent: SettingsSchema.shape.agent.partial().optional(),
  devices: SettingsSchema.shape.devices.partial().optional(),
  policy: SettingsSchema.shape.policy.partial().optional(),
  github: GitHubSettingsSchema.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const SettingsStateSchema = z.strictObject({
  settings: SettingsSchema,
  /** 설정 파일이 손상돼 기본값으로 복구했다면 그 사실. 조용히 덮어쓰지 않고 화면에 알린다. */
  issue: z.string().nullable(),
});
export type SettingsState = z.infer<typeof SettingsStateSchema>;

export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    ...current,
    evidence: { ...current.evidence, ...patch.evidence },
    agent: { ...current.agent, ...patch.agent },
    devices: { ...current.devices, ...patch.devices },
    policy: { ...current.policy, ...patch.policy },
    github: { ...current.github, ...patch.github },
  });
}

// ---------------------------------------------------------------------------
// 비밀
// ---------------------------------------------------------------------------

/** 앱이 쓰는 고정 비밀. 설정 화면에 항상 표시된다. */
export const APP_SECRET_NAMES = ["anthropicApiKey", "githubToken"] as const;
export type AppSecretName = (typeof APP_SECRET_NAMES)[number];

/** 테스트 계정 값: account:<앱 id>:<키 이름>. 키 이름은 워크스페이스 accounts.yaml 의 키와 같다. */
export const AccountSecretNameSchema = z
  .string()
  .regex(/^account:[a-z0-9][a-z0-9-]{0,39}:[A-Z][A-Z0-9_]{0,63}$/, "account:<앱>:<KEY> 형식");

export const SecretNameSchema = z.union([z.enum(APP_SECRET_NAMES), AccountSecretNameSchema]);
export type SecretName = z.infer<typeof SecretNameSchema>;

function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

export const SecretValueSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => ![...v].some(isControlChar), "제어 문자(줄바꿈 포함)는 쓸 수 없다");

export const SecretStatusSchema = z.strictObject({
  name: SecretNameSchema,
  stored: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
});
export type SecretStatus = z.infer<typeof SecretStatusSchema>;

export const SecretsListSchema = z.strictObject({
  /** safeStorage 를 쓸 수 없으면 false. 이때 비밀은 저장하지 않는다(평문 저장으로 대체하지 않음). */
  encryptionAvailable: z.boolean(),
  items: z.array(SecretStatusSchema),
});
export type SecretsList = z.infer<typeof SecretsListSchema>;

export function accountSecretName(appId: string, key: string): string {
  return `account:${appId}:${key}`;
}
