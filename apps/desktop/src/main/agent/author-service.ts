import type Anthropic from "@anthropic-ai/sdk";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AUTHOR_SYSTEM_PROMPT,
  AuditLog,
  AuthorSession,
  Budget,
  BudgetExceededError,
  DEFAULT_MODEL,
  MAESTRO_AUTHOR_TOOL_DESCRIPTIONS,
  MAESTRO_POLICY,
  MODE_LIMITS,
  McpBridge,
  SCREEN_DATA_NOTICE,
  authorUserMessage,
  errorToMcpResult,
  runAuthor,
  runnableHandler,
  toMcpResult,
  toolDefinition,
  type AuthorEvent,
  type AuthorInput,
  type BudgetLimits,
  type McpToolDefinition,
  type McpToolResult,
  type SubmitFlow,
  type ToolHandler,
} from "@qa/agent";
import {
  AuthorJobSchema,
  StartAuthorInputSchema,
  type AgentJobStatus,
  type AgentProvider,
  type AuthorJob,
  type AuthorPhase,
  type Build,
  type Device,
  type RunDetail,
  type RunSummary,
  type StartAuthorInput,
} from "@qa/shared";
import { buildSecretSet, MIN_SECRET_LENGTH, redactText, type SecretSet } from "@qa/evidence";
import { FlowMetaSchema, lintFlow, type FlowMeta } from "@qa/workspace";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import type { AuthorContext } from "../workspace/workspace-service";
import type { AgentJobStore } from "./agent-job-store";

export class AuthorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorError";
  }
}

export interface AuthorServiceOptions {
  jobs: AgentJobStore;
  workspace: {
    /** 이 TC 의 작업 브랜치로, 없으면 main 으로 옮긴다(다른 TC 의 브랜치에서 만들지 않는다) */
    useTestcaseBranch(id: string): Promise<string>;
    authorContext(app: string, id: string, target: "ios" | "android"): Promise<AuthorContext>;
    writeFlowDraft(flowPath: string, yaml: string): { abs: string; previous: string | null };
    restoreFlowDraft(flowPath: string, previous: string | null): void;
    /** 같은 내용이 이미 있으면 새로 커밋하지 않고 기존 커밋을 돌려준다(unchanged) */
    saveFlow(input: { id: string; flowPath: string; metaPath: string; yaml: string; meta: string; summary: string }): Promise<{ branch: string; commit: string; unchanged: boolean }>;
  };
  runs: {
    start(
      input: { app: string; flowPath: string; deviceId: string; buildId: string | null },
      options: { appId?: string; envKeys?: readonly string[]; trigger?: "manual" | "author" },
    ): Promise<RunSummary>;
    wait(runId: string): Promise<void>;
    get(runId: string): RunDetail;
    cancel(runId: string): RunSummary;
  };
  devices: { list(): Promise<{ devices: Device[] }> };
  builds: { get(id: string): Build; install(buildId: string, deviceId: string): Promise<{ installed: boolean }> };
  /** 누가 탐색하나(설정 agent.provider, D17). 기본은 사용자의 Claude 앱 */
  provider(): AgentProvider;
  /** 월 상한(설정). API 방식에서만 쓴다 */
  monthlyBudgetUsd(): number;
  /** 키체인의 Anthropic API 키. 렌더러로 보내지 않는다. API 방식에서만 쓴다 */
  apiKey(): string | null;
  /** 앱의 계정 값(KEY → 값) */
  accountSecrets(app: string): Record<string, string>;
  /** 앱 설정의 기본 기기 언어 */
  defaultLocale(): string;
  createClient(apiKey: string): Anthropic;
  /** 같은 기기의 잔여 드라이버를 정리하고 maestro mcp 를 stdio 로 띄운다 */
  connectMaestro(device: Device): Promise<Transport>;
  shrinkImage?: (data: Buffer, mimeType: string) => Promise<{ data: Buffer; mimeType: string }>;
  /** userData/agent (작업별 감사 기록) */
  auditDir: string;
  model?: string;
  now?: () => Date;
}

/** Claude 앱(MCP) 연결 하나. client 는 MCP clientInfo 의 이름·버전 */
export interface McpConnection {
  id: string;
  client: string;
}

/** Claude 앱 방식 작업의 상태(ADR 0022) */
interface ClaudeState {
  /** 작업을 맡은 MCP 연결. 한 작업은 한 연결만 */
  claimedBy: McpConnection | null;
  /** 마지막으로 맡은 Claude 앱(meta 의 agentModel) */
  client: string | null;
  /** 도구 이름 → 실행. maestro mcp 가 떠 있고 앱이 검사·재생 중이 아닐 때만 있다 */
  handlers: Map<string, ToolHandler> | null;
  /** attach_author 가 돌려주는 지시문과 작업 입력 */
  instructions: string;
  /** 준비 단계에서 앱이 대신 실행한 시작 서브플로우의 결과(없으면 null) */
  prelaunch: { path: string; ok: boolean; error: string | null } | null;
  secretSet: SecretSet;
  budget: Budget | null;
  audit: AuditLog | null;
}

interface Live {
  input: StartAuthorInput;
  driver: AgentProvider;
  phase: AuthorPhase;
  attempt: number;
  step: number;
  totalSteps: number;
  log: { at: string; message: string }[];
  submission: SubmitFlow | null;
  questions: string[];
  /** 직전 시도가 통과하지 못한 이유(다음 시도에 넘긴다) */
  problems: string[];
  lint: AuthorJob["lint"];
  replays: AuthorJob["replays"];
  result: AuthorJob["result"];
  claude: ClaudeState | null;
  /** 상태가 바뀔 때 부른다(author_status 의 기다림) */
  waiters: Set<() => void>;
  abort: AbortController;
  done: Promise<void>;
}

type ClaudeJob = { jobId: string; live: Live; claude: ClaudeState };

const MAX_LOG = 300;
const MAX_ATTEMPTS = 2;
/** Claude 앱 방식 작업의 model 칸. 실제 모델은 사용자의 Claude 앱이 정한다(ADR 0022) */
export const CLAUDE_APP_MODEL = "claude-app";
/** Claude 앱 방식: 사람이 Claude 에 요청을 붙여 넣는 시간까지 60분. 비용은 보이지 않아(0) 비용 상한은 걸리지 않는다 */
const CLAUDE_APP_LIMITS: BudgetLimits = { ...MODE_LIMITS.author, maxDurationMs: 60 * 60_000 };
/** Claude 앱의 MCP 요청 시간 제한(흔히 60초)에 걸리지 않게 한 번에 이만큼만 기다린다 */
const STATUS_WAIT_MAX_S = 45;
const SUBMIT_REPLY = "제출을 받았다. 앱이 규약 검사와 2회 재생을 한다(몇 분 걸린다). author_status 를 불러 결과를 기다린다.";
/**
 * 상태 초기화·앱 실행 서브플로우(PLAN 부록 B). 키체인 지우기·앱 초기화·서버 배지 대기로 1분 넘게 걸릴 수 있어
 * Claude 앱 방식에서는 앱이 준비 단계에서 대신 실행한다(Claude 앱의 MCP 요청 시간 제한에 걸리지 않게)
 */
const START_SUBFLOW = "common/launch-clean.yaml";
/** 브리지 도구 호출 하나의 상한. 드라이버 시작(최대 90초)과 시작 서브플로우가 겹쳐도 끝나게 둔다 */
const BRIDGE_CALL_TIMEOUT_MS = 240_000;

const PHASE_TEXT: Record<AuthorPhase, string> = {
  preparing: "준비",
  waiting_claude: "Claude 대기",
  exploring: "기기 탐색",
  checking: "규약 검사",
  replaying: "재생 확인",
  saving: "커밋",
  done: "끝",
};

const AttachInputSchema = z.strictObject({ jobId: z.string().min(1).max(200).optional() });
const StatusInputSchema = z.strictObject({ waitSeconds: z.number().min(0).max(STATUS_WAIT_MAX_S).optional() });
const CancelInputSchema = z.strictObject({});

/** 작업을 맡고·지켜보고·취소하는 도구(Claude 앱 방식) */
const CONTROL_TOOLS: McpToolDefinition[] = [
  {
    name: "attach_author",
    description:
      "사용자가 Avocado 의 '플로우 만들기'에서 시작한 작업을 이 대화가 맡는다. 다른 Avocado 도구보다 먼저 부른다. 결과로 지시문과 작업 입력(TC·env 키 이름·서브플로우)을 받는다.",
    inputSchema: { type: "object", properties: { jobId: { type: "string", description: "Avocado 요청 문장에 있는 작업 id. 비우면 진행 중인 작업" } }, additionalProperties: false },
  },
  {
    name: "author_status",
    description: `작업 상태와 다음 할 일을 본다. 앱이 준비·규약 검사·재생 중이면 끝날 때까지 최대 waitSeconds 초(기본 30, 최대 ${STATUS_WAIT_MAX_S}) 기다렸다가 돌려준다. submit_flow 뒤에 부른다.`,
    inputSchema: { type: "object", properties: { waitSeconds: { type: "number", minimum: 0, maximum: STATUS_WAIT_MAX_S } }, additionalProperties: false },
  },
  { name: "cancel_author", description: "맡은 작업을 취소한다.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

/**
 * 플로우 만들기(author, PLAN 6.5). 입력 조립 → 기기 준비 → 에이전트 탐색·제출 → 규약 검사 → 같은 기기에서 2회 재생 →
 * 둘 다 통과하면 작업 브랜치에 플로우·meta 커밋. 검사·재생에 실패하면 실패 정보로 한 번 다시 시도한다.
 * 탐색은 둘 중 하나가 한다(D17, ADR 0022):
 * - claude-app: 사용자의 Claude 앱이 MCP 로 이 서비스의 도구를 부른다. 앱은 모델을 부르지 않는다.
 * - api: 앱이 main 에서 Anthropic API 로 부른다.
 * 렌더러에는 진행 상태(키·계정 값 없음)만 보낸다.
 */
export class AuthorService {
  private readonly live = new Map<string, Live>();
  /** 진행 중인 작업 id. 시작 확인 중(await 사이)에도 두 번째 시작을 막으려고 "starting" 을 둔다 */
  private active: string | null = null;
  /** 마지막 Claude 앱 방식 작업(끝난 뒤에도 author_status 로 결과를 볼 수 있게) */
  private lastClaudeJob: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: AuthorServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 화면을 다시 열 때 이어 볼 작업: 진행 중인 작업, 없으면 이번 실행에서 마지막으로 시작한 작업. 없으면 null.
   * 렌더러는 화면을 떠나면 작업 id 를 잊으므로 이것으로 되찾는다.
   */
  current(): AuthorJob | null {
    const id = this.active && this.active !== "starting" ? this.active : [...this.live.keys()].at(-1);
    return id ? this.status(id) : null;
  }

  /** 워크스페이스 브랜치를 바꾸면 안 되는 이유(플로우 만들기가 워크스페이스 파일을 읽고 쓴다). 없으면 null */
  busy(): string | null {
    return this.active ? "플로우 만들기가 진행 중이다" : null;
  }

  async start(input: StartAuthorInput): Promise<AuthorJob> {
    if (this.active) throw new AuthorError("이미 플로우 만들기가 진행 중이다. 끝난 뒤 시작한다");
    this.active = "starting";
    try {
      return await this.startChecked(input);
    } catch (error) {
      if (this.active === "starting") this.active = null;
      throw error;
    }
  }

  private async startChecked(input: StartAuthorInput): Promise<AuthorJob> {
    const driver = this.options.provider();
    let apiKey: string | null = null;
    // Claude 앱 방식은 비용이 보이지 않는다. 사용자의 Claude 요금제 한도를 쓴다
    let remaining = Number.POSITIVE_INFINITY;
    if (driver === "api") {
      apiKey = this.options.apiKey();
      if (!apiKey) throw new AuthorError("Anthropic API 키가 없다. 설정에서 저장하거나 Claude 앱 방식으로 바꾼다");
      remaining = this.options.jobs.monthlyRemainingUsd(this.options.monthlyBudgetUsd());
      if (remaining <= 0) throw new AuthorError("이번 달 LLM 비용 상한에 닿았다. 설정에서 상한을 확인한다");
    }

    const device = (await this.options.devices.list()).devices.find((d) => d.id === input.deviceId);
    if (!device || device.platform !== input.target) throw new AuthorError(`${input.target} 기기를 찾지 못했다: ${input.deviceId}`);
    if (device.state !== "booted") throw new AuthorError(`기기가 실행 중이 아니다: ${device.name}. 기기 화면에서 먼저 준비한다`);
    if (input.buildId) {
      const build = this.options.builds.get(input.buildId);
      if (build.app !== input.app || build.target !== input.target) throw new AuthorError(`빌드가 ${input.app} ${input.target} 용이 아니다`);
    }
    await this.options.workspace.useTestcaseBranch(input.tcId);
    const ctx = await this.options.workspace.authorContext(input.app, input.tcId, input.target);
    const secrets = this.options.accountSecrets(input.app);
    const missing = ctx.envKeys.filter((k) => !secrets[k]);
    if (missing.length > 0) throw new AuthorError(`계정 값이 없다: ${missing.map((k) => `${input.app} · ${k}`).join(", ")}. 설정에서 저장한다`);
    const env = Object.fromEntries(ctx.envKeys.map((k) => [k, secrets[k] as string]));
    // 너무 짧은 값은 가릴 수 없어 결과·감사 기록·커밋에 남을 수 있다
    const short = ctx.envKeys.filter((k) => (secrets[k] ?? "").length < MIN_SECRET_LENGTH);
    if (short.length > 0) throw new AuthorError(`계정 값이 너무 짧아(${MIN_SECRET_LENGTH}자 미만) 가릴 수 없다: ${short.join(", ")}`);

    const model = driver === "api" ? (this.options.model ?? DEFAULT_MODEL) : CLAUDE_APP_MODEL;
    const jobId = this.options.jobs.create({ type: "author", model, input, transcriptPath: undefined });
    const auditFile = join(this.options.auditDir, `${jobId}.jsonl`);
    const live: Live = {
      input,
      driver,
      phase: "preparing",
      attempt: 0,
      step: 0,
      totalSteps: ctx.tc.steps,
      log: [],
      submission: null,
      questions: [],
      problems: [],
      lint: [],
      replays: [],
      result: null,
      claude:
        driver === "claude-app"
          ? {
              claimedBy: null,
              client: null,
              handlers: null,
              instructions: this.claudeInstructions(input, ctx, null),
              prelaunch: null,
              secretSet: buildSecretSet(Object.values(env)),
              budget: null,
              audit: null,
            }
          : null,
      waiters: new Set(),
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.live.set(jobId, live);
    this.active = jobId;
    if (live.claude) this.lastClaudeJob = jobId;
    // execute 는 던지지 않는다(작업 상태로 남긴다). 그래도 생길 수 있는 오류가 처리되지 않은 거부로 남지 않게 한다
    live.done = this.execute(jobId, live, { ctx, env, device, apiKey, model, remaining, auditFile })
      .catch(() => undefined)
      .finally(() => {
        if (this.active === jobId) this.active = null;
      });
    return this.status(jobId);
  }

  status(jobId: string): AuthorJob {
    const job = this.options.jobs.get(jobId);
    const live = this.live.get(jobId);
    if (live) {
      return {
        job,
        app: live.input.app,
        tcId: live.input.tcId,
        target: live.input.target,
        phase: live.phase,
        driver: live.driver,
        claudeRequest: live.claude && live.phase !== "done" ? claudeRequest(jobId, live.input) : null,
        claudeClient: live.claude?.client ?? null,
        attempt: live.attempt,
        step: live.step,
        totalSteps: live.totalSteps,
        log: live.log,
        submission: live.submission ? { yaml: live.submission.yaml, missingIdentifiers: live.submission.missingIdentifiers, questions: [...live.questions, ...live.submission.questions], confidence: live.submission.confidence } : null,
        lint: live.lint,
        replays: live.replays,
        result: live.result,
      };
    }
    // 앱을 다시 시작해 진행 정보가 없으면, 끝낼 때 저장한 결과로 보여 준다(진행 기록은 감사 파일에만 있다)
    if (job.type !== "author") throw new AuthorError(`플로우 만들기 작업이 아니다: ${jobId}`);
    const stored = this.options.jobs.record(jobId);
    const input = StartAuthorInputSchema.parse(stored.input);
    const output = AuthorJobSchema.pick({ submission: true, lint: true, replays: true, result: true })
      .extend({ questions: AuthorJobSchema.shape.submission.unwrap().shape.questions })
      .partial()
      .parse(stored.output ?? {});
    return {
      job,
      app: input.app,
      tcId: input.tcId,
      target: input.target,
      phase: "done",
      driver: job.model === CLAUDE_APP_MODEL ? "claude-app" : "api",
      claudeRequest: null,
      claudeClient: null,
      attempt: 0,
      step: 0,
      totalSteps: 0,
      log: [],
      submission: output.submission ?? null,
      lint: output.lint ?? [],
      replays: output.replays ?? [],
      result: output.result ?? null,
    };
  }

  cancel(jobId: string): AuthorJob {
    const live = this.live.get(jobId);
    if (!live) throw new AuthorError(`작업을 찾지 못했다: ${jobId}`);
    live.abort.abort(new AuthorError("사용자가 취소했다"));
    this.log(live, "취소를 요청했다");
    return this.status(jobId);
  }

  /** 테스트용: 작업이 끝날 때까지 기다린다 */
  async wait(jobId: string): Promise<void> {
    await this.live.get(jobId)?.done;
  }

  // ── Claude 앱 방식(MCP, ADR 0022) ──────────────────────────────────────────

  /** Claude 앱에 내보내는 도구 목록. Claude 앱은 연결할 때 한 번 읽으므로 작업이 없어도 같은 목록을 준다 */
  static mcpTools(): McpToolDefinition[] {
    return [
      ...CONTROL_TOOLS,
      ...McpBridge.toolDefinitions("maestro", MAESTRO_POLICY.author, MAESTRO_AUTHOR_TOOL_DESCRIPTIONS),
      ...AuthorSession.toolSpecs().map(toolDefinition),
    ];
  }

  /** Claude 앱의 도구 호출. 오류도 MCP 결과(isError)로 돌려줘 모델이 고칠 수 있게 한다 */
  async mcpCall(connection: McpConnection, name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    const current = this.activeClaudeJob() ?? this.lastClaude();
    const redact = (text: string) => (current ? redactText(text, current.claude.secretSet).text : text);
    try {
      if (name === "attach_author") return toMcpResult(this.attach(connection, AttachInputSchema.parse(args ?? {})));
      if (name === "author_status") return toMcpResult(await this.waitStatus(StatusInputSchema.parse(args ?? {}), signal));
      if (name === "cancel_author") {
        CancelInputSchema.parse(args ?? {});
        const { jobId } = this.claimedBy(connection);
        this.cancel(jobId);
        return toMcpResult(this.statusText(jobId));
      }
      const { jobId, live, claude } = this.claimedBy(connection);
      if (!claude.handlers) throw new AuthorError(`지금은 기기 도구를 쓸 수 없다(${PHASE_TEXT[live.phase]}). author_status 로 기다린다`);
      const handler = claude.handlers.get(name);
      if (!handler) throw new AuthorError(`모르는 도구다: ${name}`);
      try {
        return toMcpResult(await handler(args ?? {}, signal));
      } finally {
        if (claude.budget) this.options.jobs.recordUsage(jobId, claude.budget.snapshot());
      }
    } catch (error) {
      return errorToMcpResult(error, redact);
    }
  }

  /** MCP 연결이 끊기면 맡은 작업을 놓는다. 다른 대화가 attach_author 로 이어받을 수 있다 */
  releaseConnection(connectionId: string): void {
    for (const live of this.live.values()) {
      if (!live.claude || live.claude.claimedBy?.id !== connectionId || live.phase === "done") continue;
      live.claude.claimedBy = null;
      if (live.phase === "exploring") this.setPhase(live, "waiting_claude");
      this.log(live, "Claude 연결이 끊겼다. 다른 대화에서 attach_author 로 이어갈 수 있다");
    }
  }

  private claudeJob(jobId: string | null): ClaudeJob | null {
    const live = jobId ? this.live.get(jobId) : undefined;
    return jobId && live?.claude ? { jobId, live, claude: live.claude } : null;
  }

  private activeClaudeJob(): ClaudeJob | null {
    const job = this.claudeJob(this.active === "starting" ? null : this.active);
    return job && job.live.phase !== "done" ? job : null;
  }

  private lastClaude(): ClaudeJob | null {
    return this.claudeJob(this.lastClaudeJob);
  }

  private claimedBy(connection: McpConnection): ClaudeJob {
    const current = this.activeClaudeJob();
    if (!current) throw new AuthorError("진행 중인 플로우 만들기 작업이 없다. Avocado 의 '플로우 만들기'에서 시작한다");
    if (current.claude.claimedBy?.id !== connection.id) throw new AuthorError("이 대화가 맡은 작업이 아니다. 먼저 attach_author 를 부른다");
    return current;
  }

  private attach(connection: McpConnection, input: z.infer<typeof AttachInputSchema>): string {
    const current = this.activeClaudeJob();
    if (!current) throw new AuthorError("진행 중인 Claude 앱 방식 플로우 만들기 작업이 없다. Avocado 의 '플로우 만들기'에서 먼저 시작한다");
    if (input.jobId && input.jobId !== current.jobId) throw new AuthorError(`작업 ${input.jobId} 는 진행 중이 아니다. 지금 작업은 ${current.jobId} 다`);
    const { claude, live } = current;
    if (claude.claimedBy && claude.claimedBy.id !== connection.id) throw new AuthorError("다른 Claude 대화가 이 작업을 맡고 있다. 그 대화를 닫으면 이어받을 수 있다");
    if (!claude.claimedBy) {
      claude.claimedBy = connection;
      claude.client = connection.client;
      claude.audit?.write({ kind: "claude_attach", client: connection.client });
      if (live.phase === "waiting_claude") this.setPhase(live, "exploring");
      this.log(live, `Claude 가 작업을 맡았다: ${connection.client}`);
    }
    return `${claude.instructions}\n\n# 지금 상태\n${this.statusText(current.jobId)}`;
  }

  /** 모델이 할 일이 생기거나(도구 사용 가능) 작업이 끝날 때까지 기다린 뒤 상태를 돌려준다 */
  private async waitStatus(input: z.infer<typeof StatusInputSchema>, signal?: AbortSignal): Promise<string> {
    const target = this.activeClaudeJob() ?? this.lastClaude();
    if (!target) return "진행 중인 작업이 없다. 사용자에게 Avocado 의 '플로우 만들기'에서 시작하라고 알린다.";
    const { live, claude } = target;
    const actionable = () => live.phase === "done" || claude.handlers !== null;
    const ms = Math.min(input.waitSeconds ?? 30, STATUS_WAIT_MAX_S) * 1000;
    if (!actionable() && ms > 0) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          live.waiters.delete(check);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const check = () => {
          if (actionable()) finish();
        };
        const timer = setTimeout(finish, ms);
        live.waiters.add(check);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return this.statusText(target.jobId);
  }

  /** Claude 에게 보여 줄 상태 글(키·계정 값 없음) */
  private statusText(jobId: string): string {
    const s = this.status(jobId);
    const live = this.live.get(jobId);
    const lines = [
      `작업 ${jobId} · ${s.app} ${s.tcId} ${s.target} · ${s.job.status}`,
      `단계: ${PHASE_TEXT[s.phase]} · 시도 ${s.attempt}/${MAX_ATTEMPTS} · 스텝 ${s.step}/${s.totalSteps} · 도구 ${s.job.toolCalls}회`,
      `다음: ${this.nextAction(s, live)}`,
    ];
    if (live?.log.length) lines.push("최근 기록:", ...live.log.slice(-6).map((l) => `- ${l.message}`));
    return lines.join("\n");
  }

  private nextAction(s: AuthorJob, live: Live | undefined): string {
    if (s.phase === "done") {
      if (s.job.status === "succeeded" && s.result) {
        if (s.result.unchanged && s.result.branch === "main") {
          return `2회 재생을 통과했다. 같은 플로우가 이미 main 에 승인돼 있어 새로 커밋하지 않았다(${s.result.commit}). PR 은 필요 없다. 더 할 일은 없다.`;
        }
        if (s.result.unchanged) {
          return `2회 재생을 통과했다. 같은 플로우가 이미 작업 브랜치 ${s.result.branch} 에 커밋돼 있어 새로 커밋하지 않았다(${s.result.commit}). 사용자에게 Avocado 에서 PR 작성을 누르라고 알린다. 더 할 일은 없다.`;
        }
        return `2회 재생을 통과해 작업 브랜치 ${s.result.branch} 에 커밋했다(${s.result.commit}). 사용자에게 Avocado 에서 PR 작성을 누르라고 알린다. 더 할 일은 없다.`;
      }
      return `작업이 끝났다(${s.job.status})${s.job.error ? `: ${s.job.error}` : ""}. 더 할 일은 없다. 사용자에게 결과를 알린다.`;
    }
    if (live?.claude?.handlers) {
      const pre = live.claude.prelaunch;
      const start = !pre
        ? ""
        : pre.ok
          ? ` 앱이 ${pre.path} 를 실행해 시작 상태를 만들어 두었다. 다시 실행하지 말고 지금 화면에서 시작한다.`
          : ` 앱이 ${pre.path} 를 실행하지 못했다(${pre.error ?? "이유 없음"}). maestro_inspect_screen 으로 화면을 보고, 그 서브플로우 명령을 짧게 나눠 maestro_run 으로 실행해 시작 상태를 만든다.`;
      if (s.attempt > 1 && live.problems.length > 0) {
        return `직전 제출이 통과하지 못했다: ${live.problems.join(" / ")}.${start} 기기에서 다시 확인하고 고친 플로우 전체를 submit_flow 로 다시 제출한다(마지막 시도).`;
      }
      return `기기 도구를 쓸 수 있다.${start} 지시대로 begin_step 부터 진행하고 끝나면 submit_flow 를 부른다.`;
    }
    if (s.phase === "preparing" || s.phase === "waiting_claude") return "앱이 기기와 maestro 를 준비하고 있다. author_status 로 기다린다.";
    return "앱이 규약 검사와 재생을 하고 있다(몇 분). author_status 로 기다린다.";
  }

  private claudeInstructions(input: StartAuthorInput, ctx: AuthorContext, previous: { yaml: string; problems: string[] } | null): string {
    const hasStart = ctx.subflows.some((s) => s.path === START_SUBFLOW);
    return [
      "# Avocado 플로우 만들기 지시",
      "아래 지시와 작업 입력대로 Avocado 도구(maestro_*, begin_step, ask_planner, submit_flow, author_status)로만 진행한다. 이 작업에는 셸·파일·웹 같은 다른 도구를 쓰지 않는다.",
      AUTHOR_SYSTEM_PROMPT,
      SCREEN_DATA_NOTICE,
      [
        "## Claude 앱에서의 진행(위 지시보다 우선)",
        "- maestro_run 에는 한 번에 짧은 명령 묶음만 넣는다(대략 30초 안). 길어지면 Claude 앱의 요청 시간 제한에 걸려 연결이 끊긴다. 끊기면 attach_author 를 다시 부르고 이어 간다.",
        ...(hasStart
          ? [
              `- 시작 상태는 앱이 준비 단계에서 ${START_SUBFLOW} 를 대신 실행해 만든다(결과는 '지금 상태'에 나온다). 성공했으면 위 '진행'의 "서브플로우 내용을 maestro_run 에 넣어 시작한다"는 하지 않고 지금 화면에서 시작한다.`,
              `- 플로우 첫 줄에는 그대로 runFlow: ${START_SUBFLOW} 를 쓴다.`,
            ]
          : []),
      ].join("\n"),
      "## 제출 뒤\nsubmit_flow 를 부른 뒤에는 author_status 로 앱의 규약 검사·재생 결과를 기다린다. 통과하지 못하면 author_status 가 알려 주는 문제를 기기에서 확인하고 고친 플로우를 다시 제출한다(최대 2번).",
      "# 작업 입력",
      authorUserMessage(this.authorInput(input, ctx, previous)),
    ].join("\n\n");
  }

  // ── 공통 실행 ───────────────────────────────────────────────────────────────

  private log(live: Live, message: string): void {
    live.log.push({ at: this.now().toISOString(), message });
    if (live.log.length > MAX_LOG) live.log.splice(0, live.log.length - MAX_LOG);
    this.notify(live);
  }

  private setPhase(live: Live, phase: AuthorPhase): void {
    live.phase = phase;
    this.notify(live);
  }

  private notify(live: Live): void {
    for (const waiter of [...live.waiters]) waiter();
  }

  private async execute(
    jobId: string,
    live: Live,
    run: { ctx: AuthorContext; env: Record<string, string>; device: Device; apiKey: string | null; model: string; remaining: number; auditFile: string },
  ): Promise<void> {
    const { jobs } = this.options;
    const { ctx, env } = run;
    const input = live.input;
    const secretSet = buildSecretSet(Object.values(env));
    let budget: Budget | null = null;
    let audit: AuditLog | null = null;
    let draft: { previous: string | null } | null = null;
    let finished = false;
    // 어떤 경로로 끝나도 한 번은 작업 상태를 남긴다(queued·running 으로 남지 않게)
    const finish = (status: Exclude<AgentJobStatus, "queued" | "running">, error?: string) => {
      if (finished) return;
      finished = true;
      if (live.claude) live.claude.handlers = null;
      if (budget) jobs.recordUsage(jobId, budget.snapshot());
      jobs.finish(jobId, status, { output: this.storedOutput(live), error });
      live.phase = "done";
      this.log(live, `끝(${status})${error ? `: ${error}` : ""}`);
      try {
        audit?.write({ kind: "job", status, error: error ?? null });
      } catch {
        // 감사 기록 실패가 작업 결과를 바꾸지 않는다
      }
    };
    try {
      budget = new Budget(live.claude ? CLAUDE_APP_LIMITS : MODE_LIMITS.author, { monthlyRemainingUsd: run.remaining });
      audit = new AuditLog(run.auditFile, { jobId, secrets: Object.values(env) });
      if (live.claude) {
        live.claude.budget = budget;
        live.claude.audit = audit;
      }
      jobs.start(jobId);
      budget.armTimer();
      audit.write({ kind: "job", status: "running", tc: input.tcId, target: input.target, tcVersion: ctx.tcVersion, driver: live.driver });
      // 사용자 취소와 예산(시간 포함)을 재생·저장 단계까지 함께 본다
      const stop = AbortSignal.any([live.abort.signal, budget.signal]);
      if (input.buildId) {
        this.log(live, "빌드를 설치한다");
        const installed = await this.options.builds.install(input.buildId, input.deviceId);
        if (!installed.installed) throw new AuthorError("빌드 설치를 확인하지 못했다");
      }
      let problems: string[] = [];
      let previousYaml: string | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        stop.throwIfAborted();
        live.attempt = attempt;
        live.step = 0;
        live.lint = [];
        live.problems = problems;
        this.setPhase(live, live.claude ? "preparing" : "exploring");
        this.log(live, attempt === 1 ? "기기에서 TC 를 따라가며 플로우를 만든다" : `다시 시도한다: ${problems.slice(0, 3).join(" / ")}`);
        const previous = previousYaml ? { yaml: previousYaml, problems } : null;
        let raw: SubmitFlow | null;
        if (live.claude) {
          live.claude.instructions = this.claudeInstructions(input, ctx, previous);
          raw = await this.exploreWithClaude(live, live.claude, { ...run, budget, audit, secretSet, stop });
        } else {
          raw = await this.explore(jobId, live, { ...run, budget, audit, secretSet, previous });
        }
        if (!raw) throw new AuthorError("에이전트가 submit_flow 없이 끝났다");
        // 모델이 화면에서 읽은 값을 그대로 적었을 수 있다. 화면·DB·커밋에는 가린 것만 남긴다
        const submission = redactSubmission(raw, secretSet);
        live.submission = submission;
        previousYaml = submission.yaml;
        if (submission.leaked) {
          problems = ["제출한 플로우·식별자·질문에 계정 값이 그대로 들어 있다. 값 대신 ${키 이름} 을 쓴다"];
          this.log(live, "제출에 계정 값이 들어 있어 쓰지 않는다");
          continue;
        }

        this.setPhase(live, "checking");
        const issues = lintFlow(submission.yaml, { tcId: input.tcId, envKeys: ctx.envKeys, subflows: ctx.subflows.map((f) => f.path), expectations: ctx.tc.expectations });
        live.lint = issues.map(({ level, rule, message, line }) => ({ level, rule, message, line }));
        const errors = issues.filter((i) => i.level === "error");
        if (errors.length > 0) {
          problems = errors.map((e) => `규약 위반(${e.rule}${e.line ? `, ${e.line}줄` : ""}): ${e.message}`);
          this.log(live, `플로우 규약 오류 ${errors.length}개`);
          continue;
        }

        stop.throwIfAborted();
        this.setPhase(live, "replaying");
        draft = this.options.workspace.writeFlowDraft(ctx.flowPath, submission.yaml);
        const replay = await this.replayTwice(live, ctx, input, stop);
        if (replay.passed) {
          stop.throwIfAborted();
          this.setPhase(live, "saving");
          this.log(live, "두 번 모두 통과했다. 작업 브랜치에 커밋한다");
          const agentModel = live.claude ? `${CLAUDE_APP_MODEL} (${live.claude.client ?? "unknown"})` : run.model;
          const meta = this.flowMeta(input, ctx, agentModel, submission, replay.golden);
          // 초안을 먼저 되돌린다. 깨끗한 상태에서 이 TC 의 작업 브랜치로 옮겨 커밋한다
          this.options.workspace.restoreFlowDraft(ctx.flowPath, draft.previous);
          draft = null;
          const saved = await this.options.workspace.saveFlow({
            id: input.tcId,
            flowPath: ctx.flowPath,
            metaPath: ctx.metaPath,
            yaml: submission.yaml,
            meta: `# 플로우 생성 정보와 골든 런 요약 (PLAN 4.3)\n${stringify(meta)}`,
            summary: "agent flow",
          });
          live.result = { flowPath: ctx.flowPath, ...saved, goldenRunId: replay.golden.id };
          if (saved.unchanged) {
            // 같은 플로우를 다시 만들었다: 실패가 아니다. 기존 커밋을 결과로 둔다
            this.log(
              live,
              saved.branch === "main" ? `같은 플로우가 이미 main 에 있다(${saved.commit}). 새로 커밋하지 않았다` : `같은 플로우가 이미 ${saved.branch} 에 있다(${saved.commit}). 새로 커밋하지 않았다`,
            );
          }
          finish("succeeded");
          return;
        }
        this.options.workspace.restoreFlowDraft(ctx.flowPath, draft.previous);
        draft = null;
        if (replay.envIssue) throw new AuthorError(`기기 환경 문제로 재생하지 못했다: ${replay.problems.join(" / ")}`);
        problems = replay.problems;
      }
      live.problems = problems;
      finish("failed", `${MAX_ATTEMPTS}번 시도했지만 통과하지 못했다: ${problems.slice(0, 3).join(" / ")}`);
    } catch (error) {
      if (draft) {
        try {
          this.options.workspace.restoreFlowDraft(ctx.flowPath, draft.previous);
        } catch (restoreError) {
          this.log(live, `초안을 되돌리지 못했다(워크스페이스를 확인한다): ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
      }
      const exceeded = budget?.exceeded ?? (error instanceof BudgetExceededError ? error : null);
      const message = redactText(error instanceof Error ? error.message : String(error), secretSet).text;
      if (live.abort.signal.aborted && !exceeded) finish("canceled", "사용자가 취소했다");
      else if (exceeded) finish("budget_exceeded", exceeded.message);
      else finish("failed", message);
    } finally {
      budget?.dispose();
    }
  }

  private storedOutput(live: Live): unknown {
    const submission = live.submission
      ? { yaml: live.submission.yaml, missingIdentifiers: live.submission.missingIdentifiers, questions: [...live.questions, ...live.submission.questions], confidence: live.submission.confidence }
      : null;
    return { submission, questions: live.questions, lint: live.lint, replays: live.replays, result: live.result };
  }

  private authorInput(input: StartAuthorInput, ctx: AuthorContext, previous: { yaml: string; problems: string[] } | null): AuthorInput {
    return {
      tc: { id: ctx.tc.id, title: ctx.tc.title, markdown: ctx.tc.markdown, steps: ctx.tc.steps },
      app: input.app,
      target: input.target,
      appId: ctx.appId,
      locale: ctx.locale ?? this.options.defaultLocale(),
      envKeys: ctx.envKeys,
      subflows: ctx.subflows,
      previousAttempt: previous,
    };
  }

  private onAuthorEvent(live: Live, e: AuthorEvent, secretSet: SecretSet): void {
    if (e.type === "step") {
      live.step = e.step;
      this.log(live, `스텝 ${e.step}/${e.total}`);
    } else if (e.type === "question") {
      const question = redactText(e.question, secretSet).text;
      live.questions.push(question);
      this.log(live, `질문: ${question}`);
    } else if (e.type === "submitted") this.log(live, "플로우를 제출했다");
    else this.log(live, `도구: ${e.name}`);
  }

  /** maestro mcp 를 띄워 정책·예산·가림을 거치는 브리지로 잇는다. 연결에 실패하면 McpBridge.connect 가 자식 프로세스를 닫는다 */
  private async connectBridge(run: { ctx: AuthorContext; env: Record<string, string>; device: Device; budget: Budget; audit: AuditLog }): Promise<McpBridge> {
    const transport = await this.options.connectMaestro(run.device);
    return McpBridge.connect(transport, {
      serverName: "maestro",
      policy: MAESTRO_POLICY.author,
      // maestro 는 Android 를 adb serial 로 찾는다(RunService 와 같은 기준)
      deviceId: run.device.platform === "android" ? (run.device.serial ?? run.device.id) : run.device.id,
      env: run.env,
      publicEnv: { APP_ID: run.ctx.appId },
      budget: run.budget,
      audit: run.audit,
      shrinkImage: this.options.shrinkImage,
      callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
    });
  }

  /** API 방식: maestro mcp 를 띄워 한 번 탐색하고 닫는다(재생 전 드라이버 정리가 mcp 의 드라이버를 끊으므로 시도마다 새로 띄운다) */
  private async explore(
    jobId: string,
    live: Live,
    run: {
      ctx: AuthorContext;
      env: Record<string, string>;
      device: Device;
      apiKey: string | null;
      model: string;
      budget: Budget;
      audit: AuditLog;
      secretSet: SecretSet;
      previous: { yaml: string; problems: string[] } | null;
    },
  ): Promise<SubmitFlow | null> {
    if (!run.apiKey) throw new AuthorError("Anthropic API 키가 없다");
    const bridge = await this.connectBridge(run);
    try {
      const result = await runAuthor({
        client: this.options.createClient(run.apiKey),
        model: run.model,
        input: this.authorInput(live.input, run.ctx, run.previous),
        deviceTools: bridge.tools(),
        budget: run.budget,
        audit: run.audit,
        signal: live.abort.signal,
        onEvent: (e: AuthorEvent) => this.onAuthorEvent(live, e, run.secretSet),
        onMessage: () => this.options.jobs.recordUsage(jobId, run.budget.snapshot()),
      });
      return result.submission;
    } finally {
      await bridge.close();
    }
  }

  /**
   * Claude 앱 방식: maestro mcp 를 띄우고 도구를 Claude 앱에 열어 둔 채 submit_flow 를 기다린다.
   * 제출을 받으면 도구를 닫는다(앱이 검사·재생하는 동안 기기를 건드리지 못하게).
   */
  private async exploreWithClaude(
    live: Live,
    claude: ClaudeState,
    run: { ctx: AuthorContext; env: Record<string, string>; device: Device; budget: Budget; audit: AuditLog; secretSet: SecretSet; stop: AbortSignal },
  ): Promise<SubmitFlow> {
    this.log(live, "maestro mcp 를 띄운다");
    const bridge = await this.connectBridge(run);
    try {
      claude.prelaunch = null;
      const start = run.ctx.subflows.find((s) => s.path === START_SUBFLOW);
      if (start) {
        // 시작 서브플로우는 1분 넘게 걸릴 수 있다. Claude 앱의 요청 시간 제한에 걸리지 않게 앱이 대신 실행한다(드라이버 시작도 여기서 끝난다)
        this.log(live, `시작 상태를 만든다: ${START_SUBFLOW}`);
        try {
          await bridge.call("run", { yaml: start.text }, run.stop);
          claude.prelaunch = { path: START_SUBFLOW, ok: true, error: null };
          this.log(live, "앱을 초기화하고 띄웠다");
        } catch (error) {
          run.stop.throwIfAborted();
          const message = redactText(error instanceof Error ? error.message : String(error), run.secretSet).text;
          claude.prelaunch = { path: START_SUBFLOW, ok: false, error: message.slice(0, 300) };
          this.log(live, `시작 서브플로우 실패(Claude 가 화면을 보고 나눠 실행한다): ${message.slice(0, 300)}`);
        }
      } else {
        // 첫 화면 확인이 드라이버 시작으로 길어져 Claude 앱의 요청 시간 제한에 걸리지 않게 미리 한 번 읽는다
        try {
          await bridge.call("inspect_screen", {}, run.stop);
          this.log(live, "기기 화면을 미리 읽었다");
        } catch (error) {
          run.stop.throwIfAborted();
          this.log(live, `화면 미리 읽기 실패(Claude 가 다시 읽는다): ${redactText(error instanceof Error ? error.message : String(error), run.secretSet).text}`);
        }
      }
      let resolveSubmit: (submission: SubmitFlow) => void = () => undefined;
      const submitted = new Promise<SubmitFlow>((resolve) => {
        resolveSubmit = resolve;
      });
      const session: AuthorSession = new AuthorSession(
        run.ctx.tc.steps,
        run.budget,
        (e) => {
          this.onAuthorEvent(live, e, run.secretSet);
          if (e.type === "submitted" && session.submission) resolveSubmit(session.submission);
        },
        SUBMIT_REPLY,
      );
      const handlers = bridge.handlers();
      // 기기는 앱이 배정한다
      handlers.delete("maestro_list_devices");
      for (const tool of session.tools()) handlers.set(tool.name, runnableHandler(tool));
      claude.handlers = handlers;
      this.setPhase(live, claude.claimedBy ? "exploring" : "waiting_claude");
      this.log(live, claude.claimedBy ? `Claude 가 이어서 탐색한다(시도 ${live.attempt}/${MAX_ATTEMPTS})` : "Claude 를 기다린다. 요청 문장을 Claude 에 붙여 넣는다");
      return await untilAborted(submitted, run.stop);
    } finally {
      claude.handlers = null;
      await bridge.close();
    }
  }

  private async replayTwice(
    live: Live,
    ctx: AuthorContext,
    input: StartAuthorInput,
    stop: AbortSignal,
  ): Promise<{ passed: true; golden: RunSummary } | { passed: false; envIssue: boolean; problems: string[] }> {
    let last: RunSummary | null = null;
    for (let i = 1; i <= 2; i += 1) {
      stop.throwIfAborted();
      this.log(live, `재생 ${i}/2`);
      // 빌드는 시작할 때 설치했다. 앱 id 를 넣고, 계정 값은 TC 역할의 키로만 넘긴다
      const started = await this.options.runs.start(
        { app: input.app, flowPath: join(ctx.dir, ctx.flowPath), deviceId: input.deviceId, buildId: null },
        { appId: ctx.appId, envKeys: ctx.envKeys, trigger: "author" },
      );
      const onAbort = () => {
        try {
          this.options.runs.cancel(started.id);
        } catch {
          // 이미 끝났다
        }
      };
      stop.addEventListener("abort", onAbort, { once: true });
      try {
        await this.options.runs.wait(started.id);
      } finally {
        stop.removeEventListener("abort", onAbort);
      }
      stop.throwIfAborted();
      const detail = this.options.runs.get(started.id);
      live.replays.push({ runId: detail.id, status: detail.status, flaky: detail.flaky });
      if (detail.status !== "passed" || detail.flaky) {
        const failure = describeFailure(detail);
        this.log(live, `재생 ${i} 실패: ${failure.message}`);
        return { passed: false, envIssue: failure.envIssue, problems: [failure.message] };
      }
      last = detail;
    }
    if (!last) throw new AuthorError("재생 결과가 없다");
    return { passed: true, golden: last };
  }

  private flowMeta(input: StartAuthorInput, ctx: AuthorContext, agentModel: string, submission: SubmitFlow, golden: RunSummary): FlowMeta {
    return FlowMetaSchema.parse({
      tc: input.tcId,
      tcVersion: ctx.tcVersion,
      target: input.target,
      generatedBy: "agent",
      agentModel,
      goldenRun: { appBuild: golden.buildLabel ?? ctx.appId, device: golden.deviceName, result: "passed", evidenceLink: null },
      missingIdentifiers: submission.missingIdentifiers.map((m) => ({ screen: m.screenKey, element: m.description, fallback: m.fallbackSelector })),
    });
  }
}

/** Claude 에 붙여 넣을 요청 문장 */
export function claudeRequest(jobId: string, input: StartAuthorInput): string {
  return `Avocado 플로우 만들기 작업 ${jobId}(${input.app} ${input.tcId} ${input.target})를 진행해 줘. avocado 도구의 attach_author 부터 불러.`;
}

/** 취소·예산 초과 signal 이 오면 기다림을 끝낸다 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () => (signal.reason instanceof Error ? signal.reason : new AuthorError("중단됐다"));
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 재생 실패를 에이전트에게 돌려줄 문장으로. 드라이버 시작 실패는 플로우 문제가 아니다 */
function describeFailure(detail: RunDetail): { message: string; envIssue: boolean } {
  if (detail.flaky) return { message: "한 번 실패했다가 재시도에서 통과했다(불안정). 대기 조건을 보강한다", envIssue: false };
  const execution = detail.executions.findLast((e) => e.status !== "passed") ?? detail.executions.at(-1);
  if (execution?.failureClass === "env_issue" || execution?.failure?.kind === "driver_start") {
    return { message: execution.failure?.message ?? "드라이버 시작 실패", envIssue: true };
  }
  const step = execution?.steps.find((s) => s.status === "failed");
  const where = step ? `${step.index + 1}번째 명령(${step.description || step.command})` : "알 수 없는 위치";
  return { message: `${where}에서 실패: ${step?.error ?? execution?.failure?.message ?? detail.failureMessage ?? "이유 없음"}`, envIssue: false };
}

/** 제출물의 모든 글자를 가린다. 가린 곳이 있으면 leaked */
function redactSubmission(submission: SubmitFlow, set: SecretSet): SubmitFlow & { leaked: boolean } {
  let leaked = false;
  const r = (text: string) => {
    const out = redactText(text, set, { patterns: false });
    if (out.values > 0) leaked = true;
    return out.text;
  };
  const redacted = {
    yaml: r(submission.yaml),
    screenshotsPlan: submission.screenshotsPlan.map((p) => ({ stepIndex: p.stepIndex, screenKey: r(p.screenKey) })),
    missingIdentifiers: submission.missingIdentifiers.map((m) => ({ screenKey: r(m.screenKey), description: r(m.description), fallbackSelector: r(m.fallbackSelector) })),
    questions: submission.questions.map(r),
    confidence: submission.confidence,
  };
  return { ...redacted, leaked };
}
