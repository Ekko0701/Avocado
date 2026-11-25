import type { RunBatch, RunQueueStatus, RunSummary } from "@qa/shared";

export interface QueuedRun {
  tcId: string;
  input: { app: string; flowPath: string; deviceId: string; buildId: string | null };
  options: { appId?: string; skipInstall?: boolean; envKeys?: readonly string[]; trigger?: "manual" | "mcp" };
}

export type BatchMeta = Pick<RunBatch, "origin" | "app" | "target" | "deviceId" | "buildId" | "skipped">;

export class RunQueueBusyError extends Error {}

/** 끝난 묶음을 몇 개까지 기억할지. CLI 가 끝난 뒤에 결과를 다시 읽을 수 있게 한다 */
const KEEP_DONE = 20;

interface Current {
  batch: RunBatch;
  pending: QueuedRun[];
  cleared: boolean;
  activeRunId: string | null;
}

/**
 * 여러 플로우를 한 기기에서 차례로 실행한다(기기 하나에 동시에 하나, PLAN 7장). 묶음은 앱 전체에 한 번에 하나다.
 * 묶음마다 id 를 주고 조회·취소는 그 id 로만 한다(ADR 0035 결정 3). 실행 결과가 실패여도 다음으로 가지만,
 * 첫 실행이 시작하지 못하거나 오류(설치 실패 등)로 끝나면 나머지는 돌리지 않는다(빌드가 기기에 없을 수 있다).
 */
export class RunQueue {
  private current: Current | null = null;
  private done: RunBatch[] = [];
  private draining: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(
    private readonly runs: {
      start(input: QueuedRun["input"], options: QueuedRun["options"]): Promise<RunSummary>;
      wait(runId: string): Promise<void>;
      cancel(runId: string): RunSummary;
      summary(runId: string): RunSummary;
    },
    private readonly newId: () => string = () => `batch-${Date.now().toString(36)}-${(this.seq += 1)}`,
  ) {}

  enqueue(meta: BatchMeta, items: QueuedRun[]): RunBatch {
    if (this.current) throw new RunQueueBusyError(`다른 차례 실행이 진행 중이다(${this.current.batch.origin === "app" ? "실행 화면" : this.current.batch.origin}). 끝나거나 비운 뒤 다시 시작한다`);
    const batch: RunBatch = {
      id: this.newId(),
      ...meta,
      items: items.map((i) => ({ tcId: i.tcId, runId: null, status: "pending", failureMessage: null })),
      state: "running",
      errors: [],
    };
    this.current = { batch, pending: [...items], cleared: false, activeRunId: null };
    this.draining = this.drain(this.current).finally(() => {
      this.draining = null;
    });
    return structuredClone(batch);
  }

  /** 묶음이 도는 중인가. 항목 사이(실행 수가 0)에도 참이다(ADR 0035 결정 4) */
  busy(): RunBatch | null {
    return this.current ? structuredClone(this.current.batch) : null;
  }

  batch(id: string): RunBatch | null {
    const found = this.current?.batch.id === id ? this.current.batch : this.done.find((b) => b.id === id);
    return found ? structuredClone(found) : null;
  }

  /** 그 묶음이 바뀌거나 ms 가 지나면 돌아온다. 끝난 묶음은 바로 돌아온다 */
  async waitForChange(id: string, ms: number): Promise<RunBatch | null> {
    const now = this.batch(id);
    if (!now || now.state === "done" || ms <= 0) return now;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.listeners.add(finish);
    });
    return this.batch(id);
  }

  /** 그 묶음만 취소한다. 다른 묶음 id 면 아무것도 하지 않는다. 모르는 id 면 null */
  cancel(id: string): RunBatch | null {
    if (this.current?.batch.id === id) this.stop(this.current);
    return this.batch(id);
  }

  /** 실행 화면의 "차례 실행 비우기": 누가 시작했든 지금 묶음을 멈춘다 */
  clear(): void {
    if (this.current) this.stop(this.current);
  }

  status(): RunQueueStatus {
    const b = this.current?.batch ?? this.done[0] ?? null;
    if (!b) return { pending: [], running: null, errors: [], batchId: null, origin: null };
    return {
      pending: b.items.filter((i) => i.status === "pending").map((i) => i.tcId),
      running: b.items.find((i) => i.status === "running")?.tcId ?? null,
      errors: [...b.errors],
      batchId: b.id,
      origin: b.origin,
    };
  }

  /** 테스트용 */
  async idle(): Promise<void> {
    await this.draining;
  }

  private stop(c: Current): void {
    c.cleared = true;
    this.skipPending(c, "취소해서 돌리지 않았다");
    if (c.activeRunId) this.cancelRun(c.activeRunId);
    this.notify();
  }

  private skipPending(c: Current, reason: string): void {
    for (const p of c.pending) this.setItem(c, p.tcId, { status: "canceled", failureMessage: reason });
    c.pending = [];
  }

  private setItem(c: Current, tcId: string, patch: Partial<RunBatch["items"][number]>): void {
    const item = c.batch.items.find((i) => i.tcId === tcId);
    if (item) Object.assign(item, patch);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  private cancelRun(runId: string): void {
    try {
      this.runs.cancel(runId);
    } catch {
      // 이미 끝났다
    }
  }

  private async drain(c: Current): Promise<void> {
    let first = true;
    while (c.pending.length > 0) {
      const next = c.pending.shift() as QueuedRun;
      // 시작 중에도 "실행 중"으로 보이게 한다(시작 실패도 화면이 기다렸다가 오류를 보여 준다)
      this.setItem(c, next.tcId, { status: "running" });
      this.notify();
      let stop = false;
      try {
        const run = await this.runs.start(next.input, next.options);
        c.activeRunId = run.id;
        this.setItem(c, next.tcId, { runId: run.id });
        this.notify();
        if (c.cleared) this.cancelRun(run.id);
        await this.runs.wait(run.id);
        const summary = this.runs.summary(run.id);
        this.setItem(c, next.tcId, { status: summary.status, failureMessage: summary.failureMessage });
        if (first && summary.status === "error") {
          c.batch.errors.push(`${next.tcId}: 첫 실행이 오류로 끝나 나머지를 돌리지 않았다(${summary.failureMessage ?? "이유 없음"})`);
          stop = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setItem(c, next.tcId, { status: "error", failureMessage: message });
        c.batch.errors.push(`${next.tcId}: ${message}`);
        if (first) stop = true;
      } finally {
        c.activeRunId = null;
        first = false;
      }
      if (stop) this.skipPending(c, "첫 실행이 오류로 끝나 돌리지 않았다");
      this.notify();
    }
    c.batch.state = "done";
    this.done = [c.batch, ...this.done].slice(0, KEEP_DONE);
    this.current = null;
    this.notify();
  }
}
