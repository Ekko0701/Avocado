import { findSecretResidue, parseExecution, redactExecutionDir, type ParsedExecution } from "@qa/evidence";
import type { Build, Device, Execution, RunDetail, RunStep, RunSummary, StartRunInput } from "@qa/shared";
import { ExecutionSchema, RunDetailSchema, RunSummarySchema } from "@qa/shared";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "../db/database";
import { runToLog, type LoggedProcessRunner } from "../process/run-to-log";
import type { CommandRunner } from "../setup/command";
import { maestroEnv } from "../setup/setup-service";
import { cleanupDrivers } from "./drivers";
import { isLiteralAppId, readFlowInfo, type FlowInfo } from "./flow-file";

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunError";
  }
}

export interface RunServiceOptions {
  db: AppDatabase;
  devices: { list(): Promise<{ devices: Device[] }> };
  builds: { get(id: string): Build; install(buildId: string, deviceId: string): Promise<{ installed: boolean }> };
  tools: { maestroBin(): string | null; javaHome(): string | null };
  /** 앱의 테스트 계정 값(KEY → 값). maestro 에 -e 로 넘긴다 */
  accountSecrets(app: string): Record<string, string>;
  /** 가릴 값 전체(계정 값 + 앱 비밀). 증적 가림과 잔존 검사에 쓴다 */
  redactionSecrets(): string[];
  /** userData/evidence */
  evidenceRoot: string;
  /** 렌더러가 고르지 않아도 실행할 수 있는 플로우 위치(userData/workspaces, T-110) */
  trustedFlowRoots: string[];
  home: string;
  androidHome: string;
  run: CommandRunner;
  runToLog?: LoggedProcessRunner;
  /** 플로우 한 번의 제한 시간. 기본 20분 */
  flowTimeoutMs?: number;
  /** 실패 시 자동 재실행 횟수(PLAN 7.7). 기본 1 */
  retries?: number;
  loadAverage?: () => number;
  /** 이 부하 이상에서 시간 초과는 env_issue 로 본다(PLAN 7.10). 기본 CPU 수 × 2 */
  highLoad?: number;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => Date;
  newId?: () => string;
  /** 실행이 끝나 결과를 기록한 뒤 부른다(판정 등 후처리는 main 이 붙인다. 재생 경로 자체에는 LLM 이 없다) */
  onFinished?: (runId: string) => void;
}

/** run.summary 에 JSON 으로 두는 값 */
const StoredSummarySchema = RunSummarySchema.pick({
  app: true,
  flowName: true,
  flowPath: true,
  tcId: true,
  target: true,
  deviceId: true,
  deviceName: true,
  buildId: true,
  buildLabel: true,
  attempts: true,
  flaky: true,
  failureMessage: true,
});
type StoredSummary = z.infer<typeof StoredSummarySchema>;

interface RunRow {
  id: string;
  status: RunSummary["status"];
  summary: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  keep: number;
  evidence_removed_at: string | null;
}

interface ExecutionRow {
  id: string;
  attempt: number;
  status: Execution["status"];
  duration_ms: number | null;
  failure_class: Execution["failureClass"];
  failure_kind: NonNullable<Execution["failure"]>["kind"] | null;
  failure_message: string | null;
  failure_step: number | null;
  host_load: number | null;
  started_at: string | null;
  finished_at: string | null;
  warnings: string;
}

interface StepRow {
  idx: number;
  command: string;
  description: string;
  status: RunStep["status"];
  duration_ms: number | null;
  error: string | null;
  screenshot: string | null;
  failure_screenshot: string | null;
  hierarchy: string | null;
}

interface ActiveRun {
  abort: AbortController;
  deviceKey: string;
  done: Promise<void>;
}

interface AttemptResult {
  status: "passed" | "failed" | "error";
  failureClass: Execution["failureClass"];
  failureMessage: string | null;
  canceled: boolean;
  internal: boolean;
}

/**
 * 승인된 플로우를 LLM 없이 재생한다(PLAN 7장, T-107).
 * 기기 하나에 실행 하나. 실행마다 잔여 드라이버 정리 → maestro test → 원본 저장 → 가린 사본 → 잔존 검사 → 파싱 → DB 기록.
 * 실패하면 한 번 다시 실행하고, 재시도에서 통과하면 앞선 실패를 flaky 로 표시한다.
 */
export class RunService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly runner: LoggedProcessRunner;
  private readonly active = new Map<string, ActiveRun>();
  private readonly busyDevices = new Map<string, string>();
  /** main 의 선택 창으로 고른 플로우(실경로) */
  private readonly pickedFlows = new Set<string>();

  constructor(private readonly options: RunServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.runner = options.runToLog ?? runToLog;
    this.recoverInterrupted();
  }

  /** 선택 창으로 고른 플로우를 허용 목록에 넣고 정보를 돌려준다 */
  allowFlow(path: string): FlowInfo {
    const real = realpathSync(path);
    const info = readFlowInfo(real);
    this.pickedFlows.add(real);
    return info;
  }

  private assertFlowAllowed(path: string): string {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) throw new RunError(`플로우 파일이 없다: ${path}`);
    const real = realpathSync(path);
    const trusted = this.options.trustedFlowRoots.some((root) => existsSync(root) && real.startsWith(`${realpathSync(root)}${sep}`));
    if (!this.pickedFlows.has(real) && !trusted) throw new RunError("선택 창으로 고르거나 워크스페이스에 있는 플로우만 실행할 수 있다");
    return real;
  }

  /**
   * options 는 main 안에서만 쓴다(렌더러 IPC 는 넘기지 못한다).
   * - appId: 빌드 없이 ${APP_ID} 플로우를 재생할 때 넣을 앱 id(플로우 만들기 재생)
   * - envKeys: 넘길 계정 값을 이 키로만 줄인다(TC 계정 역할)
   * - trigger: run.trigger 기록
   * - skipInstall: 빌드를 기록·검사하지만 이미 설치했으므로 다시 설치하지 않는다(차례 실행의 두 번째부터)
   */
  async start(input: StartRunInput, options: { appId?: string; envKeys?: readonly string[]; trigger?: "manual" | "author"; skipInstall?: boolean } = {}): Promise<RunSummary> {
    const flowPath = this.assertFlowAllowed(input.flowPath);
    const flow = readFlowInfo(flowPath);
    const maestro = this.options.tools.maestroBin();
    const javaHome = this.options.tools.javaHome();
    if (!maestro || !javaHome) throw new RunError("Maestro·Java 런타임이 설치되지 않았다. 설정 마법사에서 설치한다");

    const device = (await this.options.devices.list()).devices.find((d) => d.id === input.deviceId);
    if (!device) throw new RunError(`기기를 찾지 못했다: ${input.deviceId}`);
    if (device.state !== "booted") throw new RunError(`기기가 실행 중이 아니다: ${device.name}. 기기 화면에서 먼저 준비한다`);
    if (device.platform === "android" && !device.serial) throw new RunError(`에뮬레이터 serial 을 알 수 없다: ${device.name}`);
    const build = input.buildId ? this.options.builds.get(input.buildId) : null;
    if (build) {
      if (build.app !== input.app) throw new RunError(`빌드의 앱(${build.app})과 실행할 앱(${input.app})이 다르다`);
      if (build.target !== device.platform) throw new RunError(`${build.target} 빌드를 ${device.platform} 기기에서 실행할 수 없다`);
      if (isLiteralAppId(flow.appId) && flow.appId !== build.appId) throw new RunError(`플로우의 appId(${flow.appId})와 빌드(${build.appId})가 다르다`);
    } else if (!isLiteralAppId(flow.appId) && !options.appId) {
      throw new RunError(`플로우의 appId 가 변수(${flow.appId})라 빌드를 골라야 한다`);
    }
    const deviceKey = `${device.platform}:${device.id}`;
    const busy = this.busyDevices.get(deviceKey);
    if (busy) throw new RunError(`이 기기에서 이미 실행 중이다: ${busy}`);

    const runId = this.newId();
    const summary: StoredSummary = {
      app: input.app,
      flowName: flow.name,
      flowPath,
      tcId: flow.tcId,
      target: device.platform,
      deviceId: device.id,
      deviceName: device.name,
      buildId: build?.id ?? null,
      buildLabel: build ? `${build.appId} ${build.version} (${build.buildNumber})` : null,
      attempts: 0,
      flaky: false,
      failureMessage: null,
    };
    const created = this.now().toISOString();
    this.options.db.db
      .prepare("INSERT INTO run (id, workspace, trigger, status, summary, created_at) VALUES (?, 'local', ?, 'queued', ?, ?)")
      .run(runId, options.trigger ?? "manual", JSON.stringify(summary), created);
    this.upsertDevice(device);

    const abort = new AbortController();
    this.busyDevices.set(deviceKey, runId);
    const appId = build?.appId ?? options.appId ?? null;
    const done = this.execute(runId, { flow, device, build, skipInstall: options.skipInstall ?? false, appId, envKeys: options.envKeys ?? null, summary, maestro, javaHome, signal: abort.signal }).finally(() => {
      this.busyDevices.delete(deviceKey);
      this.active.delete(runId);
      this.options.onFinished?.(runId);
    });
    this.active.set(runId, { abort, deviceKey, done });
    return this.summary(runId);
  }

  /** 테스트·종료 처리용: 실행이 끝날 때까지 기다린다 */
  /** 진행 중인 실행 수(워크스페이스 브랜치를 바꾸지 않게 할 때 본다) */
  activeCount(): number {
    return this.active.size;
  }

  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  cancel(runId: string): RunSummary {
    const active = this.active.get(runId);
    if (!active) throw new RunError(`실행 중이 아니다: ${runId}`);
    active.abort.abort();
    return this.summary(runId);
  }

  list(limit = 100): RunSummary[] {
    const rows = this.options.db.db.prepare("SELECT * FROM run ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RunRow[];
    return rows.map((r) => this.toSummary(r));
  }

  summary(runId: string): RunSummary {
    const row = this.options.db.db.prepare("SELECT * FROM run WHERE id = ?").get(runId) as unknown as RunRow | undefined;
    if (!row) throw new RunError(`실행을 찾지 못했다: ${runId}`);
    return this.toSummary(row);
  }

  get(runId: string): RunDetail {
    const summary = this.summary(runId);
    const db = this.options.db.db;
    const executions = (db.prepare("SELECT * FROM execution WHERE run_id = ? ORDER BY attempt").all(runId) as unknown as ExecutionRow[]).map((e) => {
      const steps = (db.prepare("SELECT * FROM step WHERE execution_id = ? ORDER BY idx").all(e.id) as unknown as StepRow[]).map(
        (s): RunStep => ({
          index: s.idx,
          command: s.command,
          description: s.description,
          status: s.status,
          durationMs: s.duration_ms,
          error: s.error,
          screenshot: s.screenshot,
          failureScreenshot: s.failure_screenshot,
          hierarchy: s.hierarchy,
        }),
      );
      return ExecutionSchema.parse({
        id: e.id,
        attempt: e.attempt,
        status: e.status,
        durationMs: e.duration_ms,
        failureClass: e.failure_class,
        failure: e.failure_kind ? { kind: e.failure_kind, message: e.failure_message ?? "", stepIndex: e.failure_step } : null,
        hostLoad: e.host_load,
        startedAt: e.started_at,
        finishedAt: e.finished_at,
        warnings: z.array(z.string()).parse(JSON.parse(e.warnings)),
        steps,
      });
    });
    return RunDetailSchema.parse({ ...summary, executions });
  }

  /** 앱이 실행 도중 꺼졌던 실행은 중단으로 기록한다 */
  private recoverInterrupted(): void {
    const db = this.options.db.db;
    const at = this.now().toISOString();
    const message = "앱이 종료돼 실행이 중단됐다";
    db.prepare(
      "UPDATE execution SET status = 'error', failure_kind = 'interrupted', failure_message = ?, finished_at = ? WHERE status IN ('queued', 'running')",
    ).run(message, at);
    for (const row of db.prepare("SELECT * FROM run WHERE status IN ('queued', 'running')").all() as unknown as RunRow[]) {
      const s = this.storedSummary(row);
      db.prepare("UPDATE run SET status = 'error', summary = ?, finished_at = ? WHERE id = ?").run(JSON.stringify({ ...s, failureMessage: message }), at, row.id);
    }
  }

  private storedSummary(row: RunRow): StoredSummary {
    return StoredSummarySchema.parse(JSON.parse(row.summary));
  }

  private toSummary(row: RunRow): RunSummary {
    return RunSummarySchema.parse({
      ...this.storedSummary(row),
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      kept: row.keep === 1,
      evidenceRemoved: row.evidence_removed_at !== null,
    });
  }

  /** "보관" 표시(PLAN 9.1). 보관한 실행은 보관 기간이 지나도 증적을 지우지 않는다 */
  setKeep(runId: string, keep: boolean): RunSummary {
    const r = this.options.db.db.prepare("UPDATE run SET keep = ? WHERE id = ?").run(keep ? 1 : 0, runId);
    if (Number(r.changes) !== 1) throw new RunError(`실행을 찾지 못했다: ${runId}`);
    return this.summary(runId);
  }

  private upsertDevice(d: Device): void {
    this.options.db.db
      .prepare(
        `INSERT INTO device (id, kind, os, os_version, name, locale, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, os = excluded.os, os_version = excluded.os_version,
           name = excluded.name, locale = excluded.locale, updated_at = excluded.updated_at`,
      )
      .run(d.id, d.kind, d.platform, d.osVersion, d.name, d.locale, this.now().toISOString());
  }

  private async execute(
    runId: string,
    ctx: {
      flow: FlowInfo;
      device: Device;
      build: Build | null;
      skipInstall: boolean;
      appId: string | null;
      envKeys: readonly string[] | null;
      summary: StoredSummary;
      maestro: string;
      javaHome: string;
      signal: AbortSignal;
    },
  ): Promise<void> {
    const db = this.options.db.db;
    db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(this.now().toISOString(), runId);
    const summary = { ...ctx.summary };
    let finalStatus: RunSummary["status"];
    try {
      if (ctx.build && !ctx.skipInstall) {
        const installed = await this.options.builds.install(ctx.build.id, ctx.device.id);
        if (!installed.installed) throw new RunError(`빌드를 설치했지만 기기에서 앱을 찾지 못했다: ${ctx.build.appId}`);
      }
      const all = this.options.accountSecrets(summary.app);
      const secrets = ctx.envKeys ? Object.fromEntries(Object.entries(all).filter(([k]) => ctx.envKeys?.includes(k))) : all;
      const results: { executionId: string; result: AttemptResult }[] = [];
      const retries = this.options.retries ?? 1;
      for (let attempt = 1; attempt <= 1 + retries; attempt += 1) {
        const executionId = this.newId();
        const result = await this.runAttempt(runId, executionId, attempt, ctx, secrets);
        results.push({ executionId, result });
        summary.attempts = attempt;
        if (result.status === "passed" || result.canceled || result.internal || ctx.signal.aborted) break;
      }
      const last = results.at(-1)?.result;
      if (last?.status === "passed" && results.length > 1) {
        // 재시도에서 통과: 환경 문제가 아닌 앞선 실패는 flaky (PLAN 7.7)
        summary.flaky = true;
        for (const r of results.slice(0, -1)) {
          if (r.result.failureClass === null) db.prepare("UPDATE execution SET failure_class = 'flaky' WHERE id = ?").run(r.executionId);
        }
      }
      finalStatus = last?.canceled ? "canceled" : (last?.status ?? "error");
      summary.failureMessage = last?.status === "passed" ? null : (last?.failureMessage ?? null);
    } catch (error) {
      summary.failureMessage = error instanceof Error ? error.message : String(error);
      finalStatus = ctx.signal.aborted ? "canceled" : "error";
    }
    db.prepare("UPDATE run SET status = ?, summary = ?, finished_at = ? WHERE id = ?").run(
      finalStatus,
      JSON.stringify(summary),
      this.now().toISOString(),
      runId,
    );
  }

  private maestroArgs(device: Device, rawDir: string, flow: FlowInfo, appId: string | null, secrets: Record<string, string>): string[] {
    const deviceArg = device.platform === "android" ? (device.serial ?? device.id) : device.id;
    const env: string[] = [];
    if (appId) env.push("-e", `APP_ID=${appId}`);
    for (const [key, value] of Object.entries(secrets)) {
      if (key !== "APP_ID") env.push("-e", `${key}=${value}`);
    }
    return [
      "--device",
      deviceArg,
      "test",
      "--test-output-dir",
      join(rawDir, "maestro"),
      "--format",
      "junit",
      "--output",
      join(rawDir, "junit.xml"),
      ...env,
      flow.path,
    ];
  }

  private async runAttempt(
    runId: string,
    executionId: string,
    attempt: number,
    ctx: { flow: FlowInfo; device: Device; build: Build | null; appId: string | null; maestro: string; javaHome: string; signal: AbortSignal },
    secrets: Record<string, string>,
  ): Promise<AttemptResult> {
    const db = this.options.db.db;
    const dir = join(this.options.evidenceRoot, runId, executionId);
    const rawDir = join(dir, "raw");
    const redactedDir = join(dir, "redacted");
    mkdirSync(rawDir, { recursive: true, mode: 0o700 });
    const hostLoad = Math.round((this.options.loadAverage ?? (() => loadavg()[0] ?? 0))() * 100) / 100;
    const started = this.now();
    db.prepare(
      `INSERT INTO execution (id, run_id, tc_id, target, flow_path, flow_blob, build_id, device_id, attempt, status, evidence_dir, host_load, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(
      executionId,
      runId,
      ctx.flow.tcId,
      ctx.device.platform,
      ctx.flow.path,
      ctx.flow.text,
      ctx.build?.id ?? null,
      ctx.device.id,
      attempt,
      relative(this.options.evidenceRoot, dir).split(sep).join("/"),
      hostLoad,
      started.toISOString(),
    );

    const warnings: string[] = [];
    let status: AttemptResult["status"];
    let failureClass: Execution["failureClass"] = null;
    let failure: { kind: NonNullable<Execution["failure"]>["kind"]; message: string; stepIndex: number | null } | null;
    let parsed: ParsedExecution | null = null;
    let canceled = false;
    let internal = false;
    try {
      const killed = await cleanupDrivers({
        run: this.options.run,
        device: ctx.device,
        androidHome: this.options.androidHome,
        kill: this.options.kill ?? ((pid, signal) => process.kill(pid, signal)),
      });
      if (killed > 0) warnings.push(`이 기기에 남아 있던 Maestro 프로세스 ${killed}개를 끝냈다`);

      const env: NodeJS.ProcessEnv = {
        ...maestroEnv(ctx.javaHome, this.options.home),
        MAESTRO_DRIVER_STARTUP_TIMEOUT: "90000",
        ANDROID_HOME: this.options.androidHome,
      };
      env["PATH"] = `${env["PATH"] ?? ""}:${join(this.options.androidHome, "platform-tools")}`;
      const timeoutMs = this.options.flowTimeoutMs ?? 20 * 60_000;
      const res = await this.runner(ctx.maestro, {
        args: this.maestroArgs(ctx.device, rawDir, ctx.flow, ctx.appId, secrets),
        env,
        cwd: dirname(ctx.flow.path),
        logFile: join(rawDir, "console.log"),
        timeoutMs,
        signal: ctx.signal,
      });
      writeFileSync(join(rawDir, "exit-code"), `${res.code}\n`, { mode: 0o600 });
      canceled = res.canceled;

      // 원본은 그대로 두고 가린 사본만 화면·묶음에 쓴다(PLAN 9.1). 사본에 값이 남으면 결과를 쓰지 않는다.
      const redactionSecrets = [...new Set([...Object.values(secrets), ...this.options.redactionSecrets()])];
      const report = redactExecutionDir(rawDir, redactedDir, { secrets: redactionSecrets });
      if (report.unredactableSecrets > 0) warnings.push(`너무 짧아 가리지 못한 비밀 값이 ${report.unredactableSecrets}개 있다. 증적을 업로드하지 않는다`);
      const residue = findSecretResidue(redactedDir, redactionSecrets);
      if (residue.length > 0) throw new RunError(`가린 사본에 비밀 값이 남았다(파일 ${residue.length}개). 결과를 쓰지 않는다`);
      parsed = parseExecution({ dir: redactedDir, exitCode: res.code });
      warnings.push(...parsed.warnings);
      status = parsed.status;
      failureClass = parsed.failureClass;
      failure = parsed.failure;
      if (res.canceled) {
        status = "error";
        failure = { kind: "canceled", message: "사용자가 실행을 취소했다", stepIndex: null };
      } else if (res.timedOut) {
        status = "error";
        failure = { kind: "interrupted", message: `제한 시간(${Math.round(timeoutMs / 60_000)}분)을 넘겨 중단했다`, stepIndex: null };
        failureClass = hostLoad >= (this.options.highLoad ?? cpus().length * 2) ? "env_issue" : null;
      }
    } catch (error) {
      internal = true;
      status = "error";
      failure = { kind: "internal", message: error instanceof Error ? error.message : String(error), stepIndex: null };
    }

    const finished = this.now();
    db.exec("BEGIN");
    try {
      db.prepare(
        `UPDATE execution SET status = ?, duration_ms = ?, failure_class = ?, failure_kind = ?, failure_message = ?, failure_step = ?,
           warnings = ?, finished_at = ? WHERE id = ?`,
      ).run(
        status,
        parsed?.durationMs ?? Math.max(0, finished.getTime() - started.getTime()),
        failureClass,
        failure?.kind ?? null,
        failure?.message ?? null,
        failure?.stepIndex ?? null,
        JSON.stringify(warnings),
        finished.toISOString(),
        executionId,
      );
      const insert = db.prepare(
        `INSERT INTO step (execution_id, idx, command, description, status, duration_ms, error, screenshot, failure_screenshot, hierarchy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of parsed?.steps ?? []) {
        insert.run(executionId, s.index, s.command, s.description, s.status, s.durationMs, s.error?.message ?? null, s.screenshot, s.failureScreenshot, s.hierarchy);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { status, failureClass, failureMessage: failure?.message ?? null, canceled, internal };
  }
}
