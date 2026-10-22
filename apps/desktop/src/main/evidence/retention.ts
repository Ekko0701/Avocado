import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/database";

const RUN_ID = /^[A-Za-z0-9-]{1,100}$/;
const DAY_MS = 24 * 60 * 60_000;
/** 한 번에 지우는 실행 수(나머지는 다음 날). 큰 증적을 한꺼번에 지우며 main 을 오래 붙잡지 않게 한다 */
const MAX_RUNS_PER_SWEEP = 50;

/**
 * 로컬 증적 보관(PLAN 9.1): 끝난 지 보관 일수(설정, 기본 30일)가 지난 실행의 증적 폴더(raw·redacted)를 지운다.
 * "보관" 표시한 실행과 진행 중인 실행은 건드리지 않는다. 실행 기록(DB)과 올린 요약 묶음은 남는다.
 */
export class EvidenceRetention {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      db: AppDatabase;
      /** userData/evidence */
      evidenceRoot: string;
      retentionDays(): number;
      now?: () => Date;
      log?: (entry: Record<string, unknown>) => void;
    },
  ) {}

  async sweep(): Promise<{ runs: number; bytes: number; errors: number }> {
    const now = (this.options.now ?? (() => new Date()))();
    const cutoff = new Date(now.getTime() - this.options.retentionDays() * DAY_MS).toISOString();
    const rows = this.options.db.db
      .prepare(
        "SELECT id FROM run WHERE keep = 0 AND evidence_removed_at IS NULL AND status NOT IN ('queued', 'running') AND finished_at IS NOT NULL AND finished_at < ? ORDER BY finished_at LIMIT ?",
      )
      .all(cutoff, MAX_RUNS_PER_SWEEP) as unknown as { id: string }[];
    const root = resolve(this.options.evidenceRoot);
    let bytes = 0;
    let runs = 0;
    let errors = 0;
    for (const { id } of rows) {
      if (!RUN_ID.test(id)) continue;
      const dir = join(root, id);
      if (!dir.startsWith(`${root}${sep}`)) continue;
      try {
        // 심볼릭 링크를 따라가 밖을 지우지 않는다(rm 은 링크 자체만 지운다)
        bytes += await sizeOf(dir);
        await rm(dir, { recursive: true, force: true });
        this.options.db.db.prepare("UPDATE run SET evidence_removed_at = ? WHERE id = ?").run(now.toISOString(), id);
        runs += 1;
      } catch (error) {
        // 한 실행이 실패해도 나머지는 계속한다. 다음 sweep 에서 다시 시도한다
        errors += 1;
        this.options.log?.({ service: "evidence-retention", runId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.options.log?.({ service: "evidence-retention", cutoff, runs, bytes, errors });
    return { runs, bytes, errors };
  }

  /** 시작 1분 뒤와 하루마다 */
  schedule(): void {
    const tick = () => {
      this.sweep().catch((error: unknown) => {
        this.options.log?.({ service: "evidence-retention", error: error instanceof Error ? error.message : String(error) });
      });
    };
    setTimeout(tick, 60_000).unref?.();
    this.timer = setInterval(tick, DAY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

async function sizeOf(path: string): Promise<number> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await readdir(path)) total += await sizeOf(join(path, name));
  return total;
}
