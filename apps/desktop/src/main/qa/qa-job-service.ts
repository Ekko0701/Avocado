import { errorToMcpResult, toMcpResult, type McpToolDefinition, type McpToolResult } from "@qa/agent";
import {
  AppIdSchema,
  QaArtifactKindSchema,
  QaJobRunLabelSchema,
  QaJobStageSchema,
  QaJobStatusSchema,
  QaVerificationSchema,
  type Device,
  type QaArtifactKind,
  type QaJob,
  type QaJobStage,
  type RunDetail,
  type RunSummary,
  type StartRunInput,
} from "@qa/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpConnection } from "../agent/author-service";
import type { CommandRunner } from "../setup/command";
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
  /** 앱 로그(가린 사본)를 두는 폴더 */
  logsDir: string;
  /** adb 실행 파일. 없거나 실패하면 앱 로그를 모으지 않는다 */
  adb: string;
  run: CommandRunner;
  /** 로그를 파일에 쓰기 전에 비밀 값을 가린다 */
  redact: (text: string) => string;
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
  verification: QaVerificationSchema.optional().describe(
    "기기 확인 결과: not_run(돌리지 않음), unverified(돌렸지만 근거 부족), verified(수정 후 실행이 통과하고 캡처로 확인함), verified_after_retry(첫 시도 실패 뒤 통과)",
  ),
  verificationNote: z.string().max(1000).optional().describe("not_run·unverified 일 때 그 이유"),
  branch: z.string().max(200).optional().describe("작업 브랜치"),
  mrUrl: z.string().max(2048).optional().describe("올린 MR 주소"),
});
const ArtifactSchema = z.strictObject({
  jobId: z.string().min(1),
  kind: QaArtifactKindSchema.describe("spec(확정한 기대값) · analysis(원인과 수정 방향) · verdict(기대값과 실제를 대조한 판정)"),
  content: z.string().min(20).max(20_000).describe("마크다운 글. 같은 종류를 다시 내면 앞의 것을 바꾼다"),
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
  {
    name: "qa_job_save_artifact",
    description:
      "단계를 마친 근거를 글로 남긴다. spec(확정한 기대값)과 analysis(원인)가 있어야 수정 단계로 넘어갈 수 있고, verdict(판정)가 있어야 성공으로 끝낼 수 있다.",
    inputSchema: jsonSchema(ArtifactSchema),
  },
  {
    name: "qa_job_report",
    description:
      "작업의 지금 단계와 한 일을 알린다. 단계가 바뀔 때마다 부른다. 끝나면 status 와 verification 을 함께 넣는다. 근거가 빠졌으면 거절하고 무엇이 빠졌는지 알려 준다.",
    inputSchema: jsonSchema(ReportSchema),
  },
  { name: "qa_job_devices", description: "지금 플로우를 돌릴 수 있는 기기(연결된 실기기, 켜진 에뮬레이터·시뮬레이터) 목록을 본다.", inputSchema: jsonSchema(EmptySchema) },
  {
    name: "qa_job_run_flow",
    description:
      "Maestro 플로우를 기기에서 재생하고 끝날 때까지 기다린다. 결과로 통과 여부, 스텝별 상태, 캡처·녹화가 있는 폴더, 그동안의 앱 로그 파일을 받는다. before·after 는 spec 을 남긴 뒤에만 돌린다. 기기의 앱 데이터를 지우는 명령(clearState, clearKeychain)은 받지 않는다.",
    inputSchema: jsonSchema(RunFlowSchema),
  },
];

/** 실기기의 로그인 상태와 받아 둔 자료를 지우는 명령. 모니터링용 실행에서는 받지 않는다 */
const DESTRUCTIVE = /\b(clearState|clearKeychain)\b/;
const STAGE_ORDER: readonly QaJobStage[] = ["received", "analysis", "fix", "build", "verify", "mr", "done"];
const ARTIFACT_LABEL: Record<QaArtifactKind, string> = { spec: "spec(확정한 기대값)", analysis: "analysis(원인과 수정 방향)", verdict: "verdict(판정)" };
/** 플로우 머리의 실제 패키지 이름. 변수(${...})면 로그를 앱으로 좁히지 못한다 */
const APP_ID_LINE = /^appId:\s*["']?([A-Za-z0-9_.]+)["']?\s*$/m;

/**
 * QA 수정 작업의 MCP 창구. 플로우 만들기·화면 판정과 달리 사용자가 앱에서 먼저 시작하지 않는다(attach 없음).
 * Claude Code 가 작업을 지휘하고, 여기서는 보고를 적고 플로우를 재생해 증적을 남긴다.
 * 사람이 지켜보지 않아도 "했다고만 하고 안 한" 단계가 통과하지 않도록, 단계마다 남겨야 할 근거를 여기서 확인한다.
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
      if (name === "qa_job_save_artifact") return toMcpResult(this.saveArtifact(ArtifactSchema.parse(args ?? {})));
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
      verification: "not_run",
      verificationNote: null,
      artifacts: [],
      events: [{ at, stage: "received", message: "작업을 시작했다" }],
      runs: [],
      createdAt: at,
      updatedAt: at,
    });
    return `시작했다. jobId: ${job.id}`;
  }

  private saveArtifact(input: z.infer<typeof ArtifactSchema>): string {
    const job = this.job(input.jobId);
    const at = this.now().toISOString();
    this.options.store.put({
      ...job,
      artifacts: [...job.artifacts.filter((a) => a.kind !== input.kind), { kind: input.kind, content: input.content, at }],
      updatedAt: at,
    });
    return `${ARTIFACT_LABEL[input.kind]} 를 적었다.`;
  }

  private missingArtifacts(job: QaJob, kinds: readonly QaArtifactKind[]): string[] {
    return kinds.filter((k) => !job.artifacts.some((a) => a.kind === k)).map((k) => ARTIFACT_LABEL[k]);
  }

  private report(input: z.infer<typeof ReportSchema>): string {
    const job = this.job(input.jobId);
    const status = input.status ?? job.status;
    const verification = input.verification ?? job.verification;
    const verificationNote = input.verificationNote ?? job.verificationNote;
    // 멈추거나 실패로 끝내는 보고는 어느 단계에서든 받는다. 그 밖에는 단계에 맞는 근거가 있어야 한다
    const stopping = status === "stopped" || status === "failed";
    if (!stopping) {
      if (STAGE_ORDER.indexOf(input.stage) >= STAGE_ORDER.indexOf("fix")) {
        const missing = this.missingArtifacts(job, ["spec", "analysis"]);
        if (missing.length > 0) throw new QaJobError(`수정 단계로 넘어가기 전에 먼저 남긴다: ${missing.join(", ")}. qa_job_save_artifact 를 쓴다`);
      }
      if (status === "succeeded") {
        const missing = this.missingArtifacts(job, ["verdict"]);
        if (missing.length > 0) throw new QaJobError(`성공으로 끝내기 전에 먼저 남긴다: ${missing.join(", ")}`);
        this.assertVerification(job, verification, verificationNote);
      }
    }
    const at = this.now().toISOString();
    this.options.store.put({
      ...job,
      stage: input.stage,
      status,
      verification,
      verificationNote,
      branch: input.branch ?? job.branch,
      mrUrl: input.mrUrl ?? job.mrUrl,
      events: [...job.events, { at, stage: input.stage, message: input.message }],
      updatedAt: at,
    });
    return "적었다.";
  }

  /** 성공으로 끝낼 때 기기 확인 결과가 실제 실행 기록과 맞는지 본다 */
  private assertVerification(job: QaJob, verification: QaJob["verification"], note: string | null): void {
    if (verification === "not_run" || verification === "unverified") {
      if (!note) throw new QaJobError(`기기 확인이 ${verification} 이면 verificationNote 에 이유를 적는다`);
      return;
    }
    const after = job.runs.filter((r) => r.label === "after").at(-1);
    if (!after || after.status !== "passed") {
      throw new QaJobError("verified 로 끝내려면 수정 후 실행(after)이 통과해야 한다. 통과한 실행이 없으면 unverified 나 not_run 으로 이유와 함께 알린다");
    }
    if (after.flaky && verification === "verified") throw new QaJobError("수정 후 실행이 첫 시도에 실패하고 다시 돌려 통과했다. verified_after_retry 로 알린다");
  }

  private async devices(): Promise<string> {
    const usable = (await this.options.devices.list()).devices.filter((d) => d.state === "booted");
    if (usable.length === 0) return "지금 쓸 수 있는 기기가 없다. 실기기를 USB 로 연결하거나 Avocado 기기 화면에서 준비한다.";
    return usable.map((d) => `- id: ${d.id} · ${d.name} · ${d.platform} ${d.osVersion} · ${d.kind === "real" ? "실기기" : d.kind === "emulator" ? "에뮬레이터" : "시뮬레이터"}`).join("\n");
  }

  private adb(serial: string, args: string[]) {
    return this.options.run(this.options.adb, ["-s", serial, ...args], { timeoutMs: 30_000 });
  }

  /**
   * 기기 시계(로그 시각과 같은 기준). 읽지 못하면 null.
   * adb shell 은 인자를 띄어쓰기로 이어 기기 셸에 넘기므로, 띄어쓰기가 든 값은 따옴표로 묶은 한 문장으로 보낸다
   */
  private async deviceTime(serial: string): Promise<string | null> {
    const r = await this.adb(serial, ["shell", "date '+%m-%d %H:%M:%S.000'"]);
    const value = r.stdout.trim();
    return r.code === 0 && /^\d\d-\d\d \d\d:\d\d:\d\d\.000$/.test(value) ? value : null;
  }

  /**
   * 실행 동안의 앱 로그를 모아 가린 사본으로 적는다. 기기의 로그 버퍼는 지우지 않는다.
   * 앱이 살아 있으면 그 프로세스의 로그만, 죽었으면 crash 버퍼를 모은다. 실패하면 null(실행 결과에는 영향 없음)
   */
  private async collectLog(serial: string, since: string, appId: string | null, runId: string): Promise<{ path: string; crashed: boolean } | null> {
    try {
      const found = appId ? ((await this.adb(serial, ["shell", "pidof", appId])).stdout.trim().split(/\s+/)[0] ?? "") : "";
      const pid = /^\d+$/.test(found) ? found : "";
      // since 는 deviceTime 이 형식을 확인한 값이다
      const app = await this.adb(serial, ["shell", `logcat -d -v threadtime -t '${since}'${pid ? ` --pid=${pid}` : ""}`]);
      const crash = await this.adb(serial, ["shell", `logcat -b crash -d -v threadtime -t '${since}'`]);
      if (app.code !== 0 && crash.code !== 0) return null;
      const crashText = crash.code === 0 ? crash.stdout.trim() : "";
      const text = [`# 앱 로그 (${since} 부터${pid ? `, pid ${pid}` : appId ? `, ${appId} 프로세스 없음: 기기 전체 로그` : ", 기기 전체 로그"})`, app.stdout.trim(), "", "# crash 버퍼", crashText || "(없음)", ""].join("\n");
      mkdirSync(this.options.logsDir, { recursive: true, mode: 0o700 });
      const path = join(this.options.logsDir, `${runId}.log`);
      writeFileSync(path, this.options.redact(text), { mode: 0o600 });
      return { path, crashed: crashText.length > 0 };
    } catch {
      return null;
    }
  }

  private async runFlow(input: z.infer<typeof RunFlowSchema>, signal?: AbortSignal): Promise<string> {
    const job = this.job(input.jobId);
    if (DESTRUCTIVE.test(input.flowYaml)) throw new QaJobError("기기의 앱 데이터를 지우는 명령(clearState, clearKeychain)이 있어 실행하지 않았다. 빼고 다시 보낸다");
    if (input.label !== "check") {
      const missing = this.missingArtifacts(job, ["spec"]);
      if (missing.length > 0) throw new QaJobError(`수정 전·후 실행은 기대값을 확정한 뒤에 돌린다. 먼저 남긴다: ${missing.join(", ")}`);
    }
    const dir = join(this.options.flowsDir, job.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const flowPath = join(dir, `${input.label}-${job.runs.length + 1}.yaml`);
    writeFileSync(flowPath, input.flowYaml, { mode: 0o600 });

    const device = (await this.options.devices.list()).devices.find((d) => d.id === input.deviceId);
    const serial = device?.platform === "android" ? device.serial : null;
    const since = serial ? await this.deviceTime(serial) : null;

    const started = await this.options.runs.start({ app: input.app, flowPath, deviceId: input.deviceId, buildId: null });
    const at = this.now().toISOString();
    this.options.store.put({
      ...this.job(job.id),
      stage: "verify",
      runs: [...this.job(job.id).runs, { runId: started.id, label: input.label, deviceName: started.deviceName, status: null, flaky: false, logPath: null, at }],
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
    const log = serial && since ? await this.collectLog(serial, since, APP_ID_LINE.exec(input.flowYaml)?.[1] ?? null, started.id) : null;
    const latest = this.job(job.id);
    this.options.store.put({
      ...latest,
      runs: latest.runs.map((r) => (r.runId === started.id ? { ...r, status, flaky: detail.flaky, logPath: log?.path ?? null } : r)),
      updatedAt: this.now().toISOString(),
    });

    const last = detail.executions.at(-1);
    const lines = [`결과: ${status}${detail.flaky ? " (첫 시도는 실패, 다시 돌려 통과)" : ""} · 시도 ${detail.attempts}회 · runId ${detail.id}`];
    if (detail.failureMessage) lines.push(`실패 이유: ${detail.failureMessage}`);
    if (last) {
      const evidence = join(this.options.evidenceRoot, detail.id, last.id, "redacted");
      lines.push(`캡처·녹화 폴더(가린 사본): ${evidence}`);
    }
    if (log) lines.push(`앱 로그(가린 사본): ${log.path}${log.crashed ? " · 실행 중 앱이 죽은 기록이 있다(crash 버퍼)" : ""}`);
    else if (serial) lines.push("앱 로그: 모으지 못했다");
    if (last) {
      lines.push("스텝:");
      for (const s of last.steps) {
        const shot = s.failureScreenshot ?? s.screenshot;
        lines.push(`${s.index + 1}. [${s.status}] ${s.description || s.command}${s.error ? ` — ${s.error}` : ""}${shot ? ` (캡처: ${shot})` : ""}`);
      }
    }
    lines.push("통과 표시만으로 판정하지 않는다. 캡처를 읽어 확정한 기대값과 대조한다.");
    return lines.join("\n");
  }
}
