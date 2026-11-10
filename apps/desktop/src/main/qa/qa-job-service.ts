import { errorToMcpResult, toMcpResult, type McpToolDefinition, type McpToolResult } from "@qa/agent";
import { AppIdSchema, QaJobRunLabelSchema, QaJobStageSchema, QaJobStatusSchema, type Device, type QaJob, type RunDetail, type RunSummary, type StartRunInput } from "@qa/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpConnection } from "../agent/author-service";
import type { QaJobStore } from "./qa-job-store";

export class QaJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaJobError";
  }
}

export interface QaJobServiceOptions {
  store: QaJobStore;
  devices: { list(): Promise<{ devices: Device[] }> };
  runs: {
    start(input: StartRunInput): Promise<RunSummary>;
    wait(runId: string): Promise<void>;
    cancel(runId: string): RunSummary;
    get(runId: string): RunDetail;
  };
  /** 받은 플로우를 적어 두는 폴더. RunService 의 trustedFlowRoots 에 들어 있어야 한다 */
  flowsDir: string;
  /** userData/evidence. 결과에 가린 사본의 위치를 알려 준다 */
  evidenceRoot: string;
  now?: () => Date;
  newId?: () => string;
}

const StartSchema = z.strictObject({
  ticket: z.string().min(1).max(120).describe("티켓 표기. 예: 앱-QA/567"),
  title: z.string().min(1).max(300).describe("티켓 제목"),
  url: z.string().max(2048).optional().describe("티켓 주소"),
});
const ReportSchema = z.strictObject({
  jobId: z.string().min(1),
  stage: QaJobStageSchema.describe("received(접수) → analysis(분석) → fix(수정) → build(빌드) → verify(기기 확인) → mr(MR) → done(끝)"),
  message: z.string().min(1).max(2000).describe("이 단계에서 한 일이나 알아낸 것. 한두 문장"),
  status: QaJobStatusSchema.optional().describe("끝났을 때만: succeeded(MR 까지 끝남), failed(오류), stopped(원인을 못 찾았거나 재현이 안 돼 사람에게 넘김)"),
  branch: z.string().max(200).optional().describe("작업 브랜치"),
  mrUrl: z.string().max(2048).optional().describe("올린 MR 주소"),
});
const RunFlowSchema = z.strictObject({
  jobId: z.string().min(1),
  label: QaJobRunLabelSchema.describe("before(수정 전 재현) · after(수정 후 확인) · check(그 밖의 확인)"),
  deviceId: z.string().min(1).describe("qa_job_devices 가 알려 준 기기 id"),
  app: AppIdSchema.describe("앱 이름(소문자·숫자·하이픈). 결과를 묶어 보는 데만 쓴다"),
  flowYaml: z.string().min(1).max(100_000).describe("Maestro 플로우 전체(appId 머리, ---, 명령 목록). appId 는 실제 패키지 이름이어야 한다"),
});
const EmptySchema = z.strictObject({});

function jsonSchema(schema: z.ZodType): McpToolDefinition["inputSchema"] {
  const out: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete out["$schema"];
  return { ...out, type: "object" };
}

const TOOLS: McpToolDefinition[] = [
  {
    name: "qa_job_start",
    description: "QA 티켓 수정 작업을 시작한다고 Avocado 에 알린다. 같은 티켓의 진행 중인 작업이 있으면 그 작업을 이어 쓴다. 결과로 jobId 를 받는다.",
    inputSchema: jsonSchema(StartSchema),
  },
  { name: "qa_job_report", description: "작업의 지금 단계와 한 일을 알린다. 단계가 바뀔 때마다 부른다. 끝나면 status 를 함께 넣는다.", inputSchema: jsonSchema(ReportSchema) },
  { name: "qa_job_devices", description: "지금 플로우를 돌릴 수 있는 기기(연결된 실기기, 켜진 에뮬레이터·시뮬레이터) 목록을 본다.", inputSchema: jsonSchema(EmptySchema) },
  {
    name: "qa_job_run_flow",
    description:
      "Maestro 플로우를 기기에서 재생하고 끝날 때까지 기다린다. 결과로 통과 여부, 스텝별 상태, 캡처·로그가 있는 폴더를 받는다. 기기의 앱 데이터를 지우는 명령(clearState, clearKeychain)은 받지 않는다.",
    inputSchema: jsonSchema(RunFlowSchema),
  },
];

/** 실기기의 로그인 상태와 받아 둔 자료를 지우는 명령. 모니터링용 실행에서는 받지 않는다 */
const DESTRUCTIVE = /\b(clearState|clearKeychain)\b/;

/**
 * QA 수정 작업의 MCP 창구. 플로우 만들기·화면 판정과 달리 사용자가 앱에서 먼저 시작하지 않는다(attach 없음).
 * Claude Code 가 작업을 지휘하고, 여기서는 보고를 적고 플로우를 재생해 증적을 남긴다.
 */
export class QaJobService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: QaJobServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  static mcpTools(): McpToolDefinition[] {
    return TOOLS;
  }

  list(): QaJob[] {
    return this.options.store.list();
  }

  async mcpCall(_connection: McpConnection, name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    try {
      if (name === "qa_job_start") return toMcpResult(this.start(StartSchema.parse(args ?? {})));
      if (name === "qa_job_report") return toMcpResult(this.report(ReportSchema.parse(args ?? {})));
      if (name === "qa_job_devices") {
        EmptySchema.parse(args ?? {});
        return toMcpResult(await this.devices());
      }
      if (name === "qa_job_run_flow") return toMcpResult(await this.runFlow(RunFlowSchema.parse(args ?? {}), signal));
      throw new QaJobError(`모르는 도구다: ${name}`);
    } catch (error) {
      if (error instanceof z.ZodError) return errorToMcpResult(error, (t) => t);
      return toMcpResult(error instanceof Error ? error.message : String(error), true);
    }
  }

  private job(jobId: string): QaJob {
    const job = this.options.store.get(jobId);
    if (!job) throw new QaJobError(`작업을 찾지 못했다: ${jobId}. qa_job_start 를 먼저 부른다`);
    return job;
  }

  private start(input: z.infer<typeof StartSchema>): string {
    const at = this.now().toISOString();
    const existing = this.options.store.list().find((j) => j.ticket === input.ticket && j.status === "running");
    if (existing) return `이어 쓴다. jobId: ${existing.id} (지금 단계: ${existing.stage})`;
    const job = this.options.store.put({
      id: this.newId(),
      ticket: input.ticket,
      title: input.title,
      url: input.url ?? null,
      stage: "received",
      status: "running",
      branch: null,
      mrUrl: null,
      events: [{ at, stage: "received", message: "작업을 시작했다" }],
      runs: [],
      createdAt: at,
      updatedAt: at,
    });
    return `시작했다. jobId: ${job.id}`;
  }

  private report(input: z.infer<typeof ReportSchema>): string {
    const job = this.job(input.jobId);
    const at = this.now().toISOString();
    this.options.store.put({
      ...job,
      stage: input.stage,
      status: input.status ?? job.status,
      branch: input.branch ?? job.branch,
      mrUrl: input.mrUrl ?? job.mrUrl,
      events: [...job.events, { at, stage: input.stage, message: input.message }],
      updatedAt: at,
    });
    return "적었다.";
  }

  private async devices(): Promise<string> {
    const usable = (await this.options.devices.list()).devices.filter((d) => d.state === "booted");
    if (usable.length === 0) return "지금 쓸 수 있는 기기가 없다. 실기기를 USB 로 연결하거나 Avocado 기기 화면에서 준비한다.";
    return usable.map((d) => `- id: ${d.id} · ${d.name} · ${d.platform} ${d.osVersion} · ${d.kind === "real" ? "실기기" : d.kind === "emulator" ? "에뮬레이터" : "시뮬레이터"}`).join("\n");
  }

  private async runFlow(input: z.infer<typeof RunFlowSchema>, signal?: AbortSignal): Promise<string> {
    const job = this.job(input.jobId);
    if (DESTRUCTIVE.test(input.flowYaml)) throw new QaJobError("기기의 앱 데이터를 지우는 명령(clearState, clearKeychain)이 있어 실행하지 않았다. 빼고 다시 보낸다");
    const dir = join(this.options.flowsDir, job.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const flowPath = join(dir, `${input.label}-${job.runs.length + 1}.yaml`);
    writeFileSync(flowPath, input.flowYaml, { mode: 0o600 });

    const started = await this.options.runs.start({ app: input.app, flowPath, deviceId: input.deviceId, buildId: null });
    const at = this.now().toISOString();
    this.options.store.put({
      ...this.job(job.id),
      stage: "verify",
      runs: [...this.job(job.id).runs, { runId: started.id, label: input.label, deviceName: started.deviceName, status: null, at }],
      updatedAt: at,
    });
    const onAbort = () => {
      try {
        this.options.runs.cancel(started.id);
      } catch {
        // 이미 끝났다
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.options.runs.wait(started.id);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const detail = this.options.runs.get(started.id);
    const status = detail.status === "passed" || detail.status === "failed" || detail.status === "canceled" ? detail.status : "error";
    const latest = this.job(job.id);
    this.options.store.put({
      ...latest,
      runs: latest.runs.map((r) => (r.runId === started.id ? { ...r, status } : r)),
      updatedAt: this.now().toISOString(),
    });

    const last = detail.executions.at(-1);
    const lines = [`결과: ${status}${detail.flaky ? " (첫 시도는 실패, 다시 돌려 통과)" : ""} · 시도 ${detail.attempts}회 · runId ${detail.id}`];
    if (detail.failureMessage) lines.push(`실패 이유: ${detail.failureMessage}`);
    if (last) {
      const evidence = join(this.options.evidenceRoot, detail.id, last.id, "redacted");
      lines.push(`캡처·로그 폴더(가린 사본): ${evidence}`, "스텝:");
      for (const s of last.steps) {
        const shot = s.failureScreenshot ?? s.screenshot;
        lines.push(`${s.index + 1}. [${s.status}] ${s.description || s.command}${s.error ? ` — ${s.error}` : ""}${shot ? ` (캡처: ${shot})` : ""}`);
      }
    }
    return lines.join("\n");
  }
}
