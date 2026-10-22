import type { AgentJobStatus, AgentJobSummary, AgentJobType, AgentUsage } from "@qa/shared";
import type { BudgetSnapshot } from "@qa/agent";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/database";

interface AgentJobRow {
  id: string;
  type: AgentJobType;
  status: AgentJobStatus;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_calls: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function toSummary(r: AgentJobRow): AgentJobSummary {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    toolCalls: r.tool_calls,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

/** 기기 현지 시간 기준 이번 달 1일 0시(UTC ISO 로 저장된 created_at 과 비교) */
function monthStart(now: Date): { iso: string; label: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { iso: start.toISOString(), label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}` };
}

const FINISHED: readonly AgentJobStatus[] = ["succeeded", "failed", "canceled", "budget_exceeded"];

/**
 * agent_job 기록(PLAN 6.4, CLAUDE.md 8장): 모든 LLM 호출의 사용량을 작업 단위로 남기고 월 비용을 집계한다.
 * 입력·출력에는 TC id 같은 참조만 두고 프롬프트·화면 내용은 감사 기록 파일(transcript_path)에 둔다.
 */
export class AgentJobStore {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: AppDatabase,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  create(job: { type: AgentJobType; model: string; input: unknown; transcriptPath?: string }): string {
    const id = this.newId();
    this.db.db
      .prepare("INSERT INTO agent_job (id, type, status, input, model, transcript_path, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)")
      .run(id, job.type, JSON.stringify(job.input), job.model, job.transcriptPath ?? null, this.now().toISOString());
    return id;
  }

  start(id: string): void {
    this.update("UPDATE agent_job SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'", this.now().toISOString(), id);
  }

  /** 예산의 누적값으로 덮어쓴다(응답마다 불러도 된다) */
  recordUsage(id: string, usage: BudgetSnapshot): void {
    this.update(
      "UPDATE agent_job SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, tool_calls = ? WHERE id = ?",
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.costUsd,
      usage.toolCalls,
      id,
    );
  }

  finish(id: string, status: Exclude<AgentJobStatus, "queued" | "running">, result: { output?: unknown; error?: string } = {}): void {
    if (!FINISHED.includes(status)) throw new Error(`끝난 상태가 아니다: ${status}`);
    this.update(
      "UPDATE agent_job SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')",
      status,
      result.output === undefined ? null : JSON.stringify(result.output),
      result.error ?? null,
      this.now().toISOString(),
      id,
    );
  }

  /** 앱이 작업 중에 꺼졌다면 다음 실행 때 실패로 정리한다 */
  recoverInterrupted(): number {
    const r = this.db.db
      .prepare("UPDATE agent_job SET status = 'failed', error = '앱이 종료되어 작업이 중단됐다', finished_at = ? WHERE status IN ('queued', 'running')")
      .run(this.now().toISOString());
    return Number(r.changes);
  }

  get(id: string): AgentJobSummary {
    const row = this.db.db.prepare("SELECT * FROM agent_job WHERE id = ?").get(id) as unknown as AgentJobRow | undefined;
    if (!row) throw new Error(`에이전트 작업을 찾지 못했다: ${id}`);
    return toSummary(row);
  }

  /** 작업을 시작할 때 넣은 입력과 끝낼 때 남긴 결과(JSON). 해석은 작업 종류별 서비스가 한다 */
  record(id: string): { input: unknown; output: unknown } {
    const row = this.db.db.prepare("SELECT input, output FROM agent_job WHERE id = ?").get(id) as unknown as { input: string; output: string | null } | undefined;
    if (!row) throw new Error(`에이전트 작업을 찾지 못했다: ${id}`);
    return { input: JSON.parse(row.input) as unknown, output: row.output === null ? null : (JSON.parse(row.output) as unknown) };
  }

  monthToDateCostUsd(): number {
    const row = this.db.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM agent_job WHERE created_at >= ?").get(monthStart(this.now()).iso) as unknown as { cost: number };
    return row.cost;
  }

  /** 새 작업을 시작할 때 Budget 에 넘기는 이번 달 남은 금액 */
  monthlyRemainingUsd(monthlyBudgetUsd: number): number {
    return Math.max(0, monthlyBudgetUsd - this.monthToDateCostUsd());
  }

  usage(monthlyBudgetUsd: number): AgentUsage {
    const { iso, label } = monthStart(this.now());
    const byType = this.db.db
      .prepare("SELECT type, COUNT(*) AS jobs, COALESCE(SUM(cost_usd), 0) AS cost FROM agent_job WHERE created_at >= ? GROUP BY type ORDER BY type")
      .all(iso) as unknown as { type: AgentJobType; jobs: number; cost: number }[];
    const recent = this.db.db.prepare("SELECT * FROM agent_job ORDER BY created_at DESC, rowid DESC LIMIT 20").all() as unknown as AgentJobRow[];
    return {
      month: label,
      costUsd: byType.reduce((sum, t) => sum + t.cost, 0),
      monthlyBudgetUsd,
      jobs: byType.reduce((sum, t) => sum + t.jobs, 0),
      byType: byType.map((t) => ({ type: t.type, jobs: t.jobs, costUsd: t.cost })),
      recent: recent.map(toSummary),
    };
  }

  private update(sql: string, ...params: (string | number | null)[]): void {
    const r = this.db.db.prepare(sql).run(...params);
    if (Number(r.changes) !== 1) throw new Error(`에이전트 작업 갱신 실패(대상 없음 또는 이미 끝남): ${String(params.at(-1))}`);
  }
}
