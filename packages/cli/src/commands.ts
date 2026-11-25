import { RunBatchSchema, RunOptionsSchema, RunStartErrorCodeSchema, StartRunsResultSchema, type RunBatch, type RunBatchItem, type RunOptions } from "@qa/shared";
import { z } from "zod";
import { ArgError, USAGE, parseArgs, type Command } from "./args";
import { AppConnectionError, connectApp, socketPath, type AppClient, type ToolReply } from "./client";
import { EXIT, START_ERROR_EXIT, batchExit, type ExitCode } from "./exit-codes";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface CliContext {
  io: Io;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** Ctrl-C 를 받으면 부를 함수를 건다. run 만 건다(자기 묶음을 취소한다) */
  onInterrupt?(handler: (() => void) | null): void;
  /** 시험용: runs_status 한 번의 기다림(초) */
  waitSeconds?: number;
}

const STATUS_WORD: Record<RunBatchItem["status"], string> = {
  pending: "대기",
  queued: "대기",
  running: "실행 중",
  passed: "통과",
  failed: "실패",
  error: "오류",
  canceled: "취소",
};

/** 앱이 준 결과가 약속한 모양이 아니다. 앱과 CLI 버전이 다를 때 생길 수 있다(종료 코드 6) */
class ProtocolError extends Error {}

const ToolErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

function parse<T>(schema: z.ZodType<T>, reply: ToolReply, what: string): T {
  const r = schema.safeParse(reply.value);
  if (!r.success) throw new ProtocolError(`${what} 결과를 읽지 못했다(앱과 CLI 버전이 맞는지 확인한다): ${typeof reply.value === "string" ? reply.value : r.error.message}`);
  return r.data;
}

/** avocado 명령 하나를 실행하고 종료 코드를 돌려준다. 출력은 io 로만 한다 */
export async function runCli(argv: string[], ctx: CliContext): Promise<ExitCode> {
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    ctx.io.err(`avocado: ${error.message}`);
    ctx.io.err(USAGE);
    return EXIT.args;
  }
  if (command.kind === "help") {
    ctx.io.out(USAGE);
    return EXIT.ok;
  }
  let app: AppClient;
  try {
    app = await connectApp(socketPath(ctx.env, ctx.home));
  } catch (error) {
    if (!(error instanceof AppConnectionError)) throw error;
    ctx.io.err(`avocado: ${error.message}`);
    return EXIT.connect;
  }
  try {
    if (!command.json) ctx.io.err(`Avocado ${app.appVersion} 에 연결했다`);
    if (command.kind === "run") return await run(app, command, ctx);
    if (command.kind === "status") return await status(app, command, ctx);
    if (command.kind === "cancel") return await cancel(app, command, ctx);
    return await options(app, command, ctx);
  } catch (error) {
    if (error instanceof AppConnectionError) {
      ctx.io.err(`avocado: ${error.message}`);
      return EXIT.connect;
    }
    if (error instanceof ProtocolError) {
      ctx.io.err(`avocado: ${error.message}`);
      return EXIT.error;
    }
    throw error;
  } finally {
    ctx.onInterrupt?.(null);
    await app.close().catch(() => undefined);
  }
}

async function run(app: AppClient, command: Extract<Command, { kind: "run" }>, ctx: CliContext): Promise<ExitCode> {
  // Ctrl-C 처리기는 시작을 부르기 전에 건다. 시작 응답을 기다리는 사이에 눌러도 묶음을 받자마자 취소한다
  let batchId: string | null = null;
  let interrupted = false;
  let cancelSent = false;
  const requestCancel = () => {
    if (!batchId || cancelSent) return;
    cancelSent = true;
    if (!command.json) ctx.io.err(`취소를 요청했다: ${batchId}`);
    void app.call("cancel_runs", { batchId }).catch(() => undefined);
  };
  ctx.onInterrupt?.(() => {
    if (interrupted) return;
    interrupted = true;
    requestCancel();
  });
  const reply = await app.call("start_runs", {
    app: command.app,
    ...(command.tcIds ? { tcIds: command.tcIds } : { tag: command.tag }),
    ...(command.target ? { target: command.target } : {}),
    ...(command.device ? { deviceId: command.device } : {}),
    ...(command.build ? { buildId: command.build } : {}),
  });
  if (reply.isError && typeof reply.value === "string") {
    ctx.io.err(`avocado: ${reply.value}`);
    return EXIT.args;
  }
  const started = parse(StartRunsResultSchema, reply, "start_runs");
  if ("error" in started) {
    const e = started.error;
    if (command.json) ctx.io.out(JSON.stringify({ error: e }));
    ctx.io.err(`avocado: ${e.message}`);
    if (e.candidates?.length) ctx.io.err(`후보: ${e.candidates.join(", ")}`);
    if (e.code === "device_ambiguous") ctx.io.err("--device <id> 로 기기를 고른다. avocado qa options 로 준비된 기기를 본다");
    return START_ERROR_EXIT[e.code];
  }
  const batch = started.batch;
  batchId = batch.id;
  if (!command.json) {
    ctx.io.err(`묶음 ${batch.id} · ${batch.app} ${batch.target} · 기기 ${batch.deviceId}${batch.buildId ? ` · 빌드 ${batch.buildId}` : ""}`);
    for (const s of batch.skipped) ctx.io.err(`${s.tcId} 건너뜀: ${batch.target} 플로우가 없다`);
    ctx.io.err("Ctrl-C 로 이 묶음을 취소한다");
  }
  if (interrupted) requestCancel();
  return finish(await follow(app, batch, ctx, command.json), command.json, ctx);
}

async function status(app: AppClient, command: Extract<Command, { kind: "status" }>, ctx: CliContext): Promise<ExitCode> {
  const first = await app.call("runs_status", { batchId: command.batchId });
  if (first.isError) return toolError(first, command.json, ctx);
  const batch = parse(RunBatchSchema, first, "runs_status");
  if (!command.follow && batch.state !== "done") {
    if (command.json) ctx.io.out(JSON.stringify(batch));
    else printItems(batch, ctx);
    return EXIT.ok;
  }
  return finish(command.follow ? await follow(app, batch, ctx, command.json) : batch, command.json, ctx);
}

async function cancel(app: AppClient, command: Extract<Command, { kind: "cancel" }>, ctx: CliContext): Promise<ExitCode> {
  const reply = await app.call("cancel_runs", { batchId: command.batchId });
  if (reply.isError) return toolError(reply, command.json, ctx);
  const batch = parse(RunBatchSchema, reply, "cancel_runs");
  if (command.json) ctx.io.out(JSON.stringify(batch));
  else ctx.io.out(batch.state === "done" ? `이미 끝난 묶음이다: ${batch.id}` : `취소를 요청했다: ${batch.id}. avocado qa status ${batch.id} 로 끝까지 본다`);
  return EXIT.ok;
}

async function options(app: AppClient, command: Extract<Command, { kind: "options" }>, ctx: CliContext): Promise<ExitCode> {
  const o: RunOptions = parse(RunOptionsSchema, await app.call("run_options", {}), "run_options");
  if (command.json) {
    ctx.io.out(JSON.stringify(o));
    return EXIT.ok;
  }
  const { out } = ctx.io;
  out(`앱 버전 ${o.appVersion}${o.busy ? ` · ${o.busy}` : ""}`);
  if (!o.workspaceConnected) out("워크스페이스가 연결되지 않았다. 앱의 워크스페이스 화면에서 연결한다");
  out("");
  out("테스트 케이스");
  for (const a of o.apps) {
    for (const t of a.testcases) out(`  ${a.app}-${t.id}  ${t.flows.length ? t.flows.join(",") : "플로우 없음"}  ${t.status}  ${t.tags.length ? `[${t.tags.join(", ")}] ` : ""}${t.title}`);
    if (a.testcases.length === 0) out(`  ${a.app}: 테스트 케이스 없음`);
  }
  out("");
  out("준비된 기기");
  for (const d of o.devices) out(`  ${d.id}  ${d.platform} ${d.kind}  ${d.name}`);
  if (o.devices.length === 0) out("  없음. 앱의 기기 화면에서 준비한다");
  out("");
  out("빌드");
  for (const b of o.builds) out(`  ${b.id}  ${b.app} ${b.target}  ${b.label}`);
  if (o.builds.length === 0) out("  없음(기기에 설치된 앱으로 실행한다)");
  return EXIT.ok;
}

function toolError(reply: ToolReply, json: boolean, ctx: CliContext): ExitCode {
  const e = ToolErrorSchema.safeParse(reply.value);
  if (!e.success) {
    ctx.io.err(`avocado: ${String(reply.value)}`);
    // JSON 이 아닌 오류 글자는 입력 형식 오류다
    return typeof reply.value === "string" ? EXIT.args : EXIT.error;
  }
  if (json) ctx.io.out(JSON.stringify(reply.value));
  ctx.io.err(`avocado: ${e.data.error.message}`);
  // 모르는 묶음 id 는 인자 오류다. 앱이 다시 켜지면 묶음 기록이 없어진다
  if (e.data.error.code === "unknown_batch") return EXIT.args;
  const code = RunStartErrorCodeSchema.safeParse(e.data.error.code);
  return code.success ? START_ERROR_EXIT[code.data] : EXIT.error;
}

/** 묶음이 끝날 때까지 runs_status 로 따라가며 항목이 바뀔 때마다 한 줄씩 알린다 */
async function follow(app: AppClient, start: RunBatch, ctx: CliContext, json: boolean): Promise<RunBatch> {
  const seen = new Map<string, string>();
  const report = (b: RunBatch) => {
    if (json) return;
    for (const item of b.items) {
      // 실행 id 가 붙는 것(시작 중 → 시작함)은 같은 "실행 중"이라 다시 알리지 않는다
      const key = item.status;
      if (seen.get(item.tcId) === key || item.status === "pending") continue;
      seen.set(item.tcId, key);
      ctx.io.err(`${item.tcId} ${STATUS_WORD[item.status]}${item.failureMessage && item.status !== "running" ? ` · ${item.failureMessage}` : ""}`);
    }
  };
  let batch = start;
  report(batch);
  while (batch.state !== "done") {
    const reply = await app.call("runs_status", { batchId: batch.id, waitSeconds: ctx.waitSeconds ?? 30 });
    if (reply.isError) throw new ProtocolError(`묶음을 더 읽지 못했다: ${JSON.stringify(reply.value)}`);
    batch = parse(RunBatchSchema, reply, "runs_status");
    report(batch);
  }
  return batch;
}

function printItems(batch: RunBatch, ctx: CliContext): void {
  ctx.io.out(`묶음 ${batch.id} · ${batch.state === "done" ? "끝남" : "진행 중"} · ${batch.app} ${batch.target} · 기기 ${batch.deviceId}`);
  for (const item of batch.items) ctx.io.out(`  ${item.tcId}  ${STATUS_WORD[item.status]}${item.runId ? `  실행 ${item.runId}` : ""}${item.failureMessage ? `  ${item.failureMessage}` : ""}`);
  for (const s of batch.skipped) ctx.io.out(`  ${s.tcId}  건너뜀(플로우 없음)`);
  for (const e of batch.errors) ctx.io.out(`  ! ${e}`);
}

function finish(batch: RunBatch, json: boolean, ctx: CliContext): ExitCode {
  if (json) ctx.io.out(JSON.stringify(batch));
  else {
    printItems(batch, ctx);
    ctx.io.out("증적과 스텝은 Avocado 결과 화면에서 본다");
  }
  return batchExit(batch);
}
