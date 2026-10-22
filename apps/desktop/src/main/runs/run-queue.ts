import type { RunSummary } from "@qa/shared";

export interface QueuedRun {
  label: string;
  input: { app: string; flowPath: string; deviceId: string; buildId: string | null };
  options: { appId?: string; skipInstall?: boolean };
}

/**
 * 태그로 고른 여러 플로우를 한 기기에서 차례로 실행한다(기기 하나에 동시에 하나, PLAN 7장).
 * 앞 실행이 끝나야 다음을 시작한다. 실행 결과가 실패여도 다음으로 가지만, 첫 실행이 시작하지 못하거나
 * 오류(설치 실패 등)로 끝나면 나머지는 돌리지 않는다(빌드가 기기에 없을 수 있다).
 */
export class RunQueue {
  private pending: QueuedRun[] = [];
  /** 시작 중이거나 실행 중인 것(시작 중에는 runId 가 없다) */
  private active: { label: string; runId: string | null } | null = null;
  private cleared = false;
  private draining: Promise<void> | null = null;
  private readonly errors: string[] = [];

  constructor(
    private readonly runs: {
      start(input: QueuedRun["input"], options: QueuedRun["options"]): Promise<RunSummary>;
      wait(runId: string): Promise<void>;
      cancel(runId: string): RunSummary;
      summary(runId: string): RunSummary;
    },
  ) {}

  enqueue(items: QueuedRun[]): void {
    if (this.draining) throw new Error("이미 차례 실행 중이다. 끝나거나 비운 뒤 다시 시작한다");
    this.pending = [...items];
    this.cleared = false;
    this.errors.length = 0;
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
  }

  status(): { pending: string[]; running: string | null; errors: string[] } {
    return { pending: this.pending.map((p) => p.label), running: this.active?.label ?? null, errors: [...this.errors] };
  }

  /** 남은 것을 비우고 진행 중인 실행을 취소한다. 시작 중인 것도 시작되는 대로 취소한다 */
  clear(): void {
    this.pending = [];
    this.cleared = true;
    if (this.active?.runId) this.cancel(this.active.runId);
  }

  /** 테스트용 */
  async idle(): Promise<void> {
    await this.draining;
  }

  private cancel(runId: string): void {
    try {
      this.runs.cancel(runId);
    } catch {
      // 이미 끝났다
    }
  }

  private async drain(): Promise<void> {
    let first = true;
    while (this.pending.length > 0) {
      const next = this.pending.shift() as QueuedRun;
      // 시작 중에도 상태가 "실행 중"으로 보이게 한다(시작 실패도 화면이 기다렸다가 오류를 보여 준다)
      this.active = { label: next.label, runId: null };
      let stop = false;
      try {
        const run = await this.runs.start(next.input, next.options);
        this.active = { label: next.label, runId: run.id };
        if (this.cleared) this.cancel(run.id);
        await this.runs.wait(run.id);
        if (first && this.runs.summary(run.id).status === "error") {
          this.errors.push(`${next.label}: 첫 실행이 오류로 끝나 나머지를 돌리지 않았다(${this.runs.summary(run.id).failureMessage ?? "이유 없음"})`);
          stop = true;
        }
      } catch (error) {
        this.errors.push(`${next.label}: ${error instanceof Error ? error.message : String(error)}`);
        if (first) stop = true;
      } finally {
        this.active = null;
        first = false;
      }
      if (stop) this.pending = [];
    }
  }
}
