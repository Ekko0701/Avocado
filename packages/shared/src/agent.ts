import { z } from "zod";
import { AppIdSchema } from "./builds";

/** agent_job.type / status (PLAN 7장) */
export const AgentJobTypeSchema = z.enum(["author", "heal", "judge", "explore"]);
export type AgentJobType = z.infer<typeof AgentJobTypeSchema>;
export const AgentJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled", "budget_exceeded"]);
export type AgentJobStatus = z.infer<typeof AgentJobStatusSchema>;

export const AgentJobSummarySchema = z.strictObject({
  id: z.string(),
  type: AgentJobTypeSchema,
  status: AgentJobStatusSchema,
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  toolCalls: z.number().int().min(0),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AgentJobSummary = z.infer<typeof AgentJobSummarySchema>;

/** 이번 달 LLM 사용량(설정 화면). 월은 기기 현지 시간 기준 */
export const AgentUsageSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  costUsd: z.number().min(0),
  monthlyBudgetUsd: z.number().min(0),
  jobs: z.number().int().min(0),
  byType: z.array(z.strictObject({ type: AgentJobTypeSchema, jobs: z.number().int().min(0), costUsd: z.number().min(0) })),
  recent: z.array(AgentJobSummarySchema).max(20),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

/** "플로우 만들기"(author, PLAN 6.5) */
export const StartAuthorInputSchema = z.strictObject({
  app: AppIdSchema,
  tcId: z.string().regex(/^TC-\d{4,}$/),
  target: z.enum(["ios", "android"]),
  deviceId: z.string().min(1).max(200),
  /** 설치할 빌드. null 이면 기기에 설치된 앱으로 한다 */
  buildId: z.string().min(1).max(200).nullable(),
});
export type StartAuthorInput = z.infer<typeof StartAuthorInputSchema>;

export const AgentJobRefSchema = z.strictObject({ jobId: z.string().min(1).max(200) });

/** waiting_claude: Claude 앱 방식에서 기기 준비를 마치고 Claude 가 attach_author 로 맡기를 기다린다(ADR 0022) */
export const AuthorPhaseSchema = z.enum(["preparing", "waiting_claude", "exploring", "checking", "replaying", "saving", "done"]);
export type AuthorPhase = z.infer<typeof AuthorPhaseSchema>;

export const AuthorJobSchema = z.strictObject({
  job: AgentJobSummarySchema,
  app: z.string(),
  tcId: z.string(),
  target: z.enum(["ios", "android"]),
  phase: AuthorPhaseSchema,
  /** 누가 탐색하나: 앱이 API 로(api) 또는 사용자의 Claude 앱이 MCP 로(claude-app) */
  driver: z.enum(["api", "claude-app"]),
  /** Claude 앱 방식: Claude 에 붙여 넣을 요청 문장. 끝난 작업이나 API 방식은 null */
  claudeRequest: z.string().nullable(),
  /** Claude 앱 방식: 작업을 맡은 Claude 앱(MCP clientInfo 이름·버전) */
  claudeClient: z.string().nullable(),
  /** 1·2. 실패 정보로 한 번 다시 시도한다 */
  attempt: z.number().int().min(0).max(2),
  step: z.number().int().min(0),
  totalSteps: z.number().int().min(0),
  log: z.array(z.strictObject({ at: z.string(), message: z.string() })).max(300),
  submission: z
    .strictObject({
      yaml: z.string(),
      missingIdentifiers: z.array(z.strictObject({ screenKey: z.string(), description: z.string(), fallbackSelector: z.string() })),
      questions: z.array(z.string()),
      confidence: z.number(),
    })
    .nullable(),
  lint: z.array(z.strictObject({ level: z.enum(["error", "warning"]), rule: z.string(), message: z.string(), line: z.number().int().nullable() })),
  replays: z.array(z.strictObject({ runId: z.string(), status: z.string(), flaky: z.boolean() })),
  /** unchanged: 같은 플로우·meta 가 이미 있어 새로 커밋하지 않았다(branch·commit 은 그 기존 것). 예전 결과에는 없어 기본 false */
  result: z.strictObject({ flowPath: z.string(), branch: z.string(), commit: z.string(), goldenRunId: z.string(), unchanged: z.boolean().default(false) }).nullable(),
});
export type AuthorJob = z.infer<typeof AuthorJobSchema>;

/** 화면 판정(judge, PLAN 6.7). 결과는 배지로만 보이고 실행 상태를 바꾸지 않는다 */
export const JudgementSchema = z.strictObject({
  stepIndex: z.number().int().min(0).nullable(),
  verdict: z.enum(["pass", "fail", "uncertain"]),
  defects: z.array(z.strictObject({ type: z.string(), description: z.string() })),
  confidence: z.number().min(0).max(1).nullable(),
  reason: z.string().nullable(),
  model: z.string(),
  createdAt: z.string(),
});
export type Judgement = z.infer<typeof JudgementSchema>;

/** Claude 앱 방식 화면 판정 작업(ADR 0022). 사용자의 Claude 앱이 MCP 로 캡처를 받아 판정을 제출한다 */
export const ClaudeJudgeJobSchema = z.strictObject({
  job: AgentJobSummarySchema,
  runId: z.string(),
  executionId: z.string(),
  /** waiting_claude: Claude 가 attach_judge 로 맡기를 기다린다 */
  phase: z.enum(["waiting_claude", "judging", "done"]),
  total: z.number().int().min(0),
  judged: z.number().int().min(0),
  /** Claude 에 붙여 넣을 요청 문장. 끝난 작업은 null */
  claudeRequest: z.string().nullable(),
  claudeClient: z.string().nullable(),
});
export type ClaudeJudgeJob = z.infer<typeof ClaudeJudgeJobSchema>;

/** Claude 앱 연결(MCP, ADR 0022) 상태. 설정 화면에 보인다 */
export const ClaudeConnectionSchema = z.strictObject({
  /** 앱이 MCP 소켓을 열었나. 다른 Avocado 가 쓰고 있거나 실패하면 false 와 이유 */
  listening: z.boolean(),
  socketPath: z.string(),
  error: z.string().nullable(),
  /** 지금 연결된 Claude 앱 */
  clients: z.array(z.strictObject({ name: z.string(), version: z.string(), connectedAt: z.string() })),
  desktop: z.strictObject({
    configPath: z.string(),
    /** missing_app: 설정 폴더가 없다, invalid: JSON 이 아니라 건드리지 않는다, outdated: 다른 명령으로 등록돼 있다 */
    state: z.enum(["missing_app", "not_configured", "configured", "outdated", "invalid"]),
  }),
  /** Claude Code 에 등록하는 명령(사용자가 터미널에서 실행) */
  codeCommand: z.string(),
});
export type ClaudeConnection = z.infer<typeof ClaudeConnectionSchema>;
