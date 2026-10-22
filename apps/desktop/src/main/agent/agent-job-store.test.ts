import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../db/database";
import { AgentJobStore } from "./agent-job-store";

let db: AppDatabase;
let now: Date;
let seq = 0;

beforeEach(() => {
  db = AppDatabase.open(join(mkdtempSync(join(tmpdir(), "qa-agent-jobs-")), "db.sqlite"));
  now = new Date(2026, 9, 22, 1, 0, 0);
  seq = 0;
});
afterEach(() => {
  db.close();
});

const store = () => new AgentJobStore(db, { now: () => now, newId: () => `job-${++seq}` });
const snapshot = (costUsd: number, toolCalls = 1) => ({ toolCalls, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 20, costUsd, elapsedMs: 10 });

describe("AgentJobStore", () => {
  it("작업 수명: queued → running → 사용량 기록 → 끝", () => {
    const jobs = store();
    const id = jobs.create({ type: "author", model: "claude-opus-5-5", input: { tc: "TC-0101" } });
    expect(jobs.get(id).status).toBe("queued");
    jobs.start(id);
    jobs.recordUsage(id, snapshot(0.12, 4));
    jobs.finish(id, "succeeded", { output: { flow: "flows/demo/ios/TC-0101.yaml" } });
    expect(jobs.get(id)).toMatchObject({ status: "succeeded", inputTokens: 1000, outputTokens: 100, costUsd: 0.12, toolCalls: 4, error: null });
    const row = db.db.prepare("SELECT cache_read_tokens, cache_write_tokens, output FROM agent_job WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row).toEqual({ cache_read_tokens: 50, cache_write_tokens: 20, output: '{"flow":"flows/demo/ios/TC-0101.yaml"}' });
    // 끝난 작업은 다시 끝낼 수 없다
    expect(() => jobs.finish(id, "failed")).toThrow(/이미 끝남/);
  });

  it("이번 달(현지 시간) 비용만 집계하고 남은 금액을 준다", () => {
    const jobs = store();
    now = new Date(2026, 8, 30, 23, 0, 0);
    const old = jobs.create({ type: "author", model: "claude-opus-5-5", input: {} });
    jobs.recordUsage(old, snapshot(50));
    now = new Date(2026, 9, 1, 0, 30, 0);
    const a = jobs.create({ type: "author", model: "claude-opus-5-5", input: {} });
    jobs.recordUsage(a, snapshot(3.5));
    const j = jobs.create({ type: "judge", model: "claude-opus-5-5", input: {} });
    jobs.recordUsage(j, snapshot(0.25));
    jobs.finish(j, "budget_exceeded", { error: "작업 비용 상한" });

    expect(jobs.monthToDateCostUsd()).toBeCloseTo(3.75, 9);
    expect(jobs.monthlyRemainingUsd(5)).toBeCloseTo(1.25, 9);
    expect(jobs.monthlyRemainingUsd(3)).toBe(0);
    const usage = jobs.usage(100);
    expect(usage).toMatchObject({ month: "2026-10", jobs: 2, monthlyBudgetUsd: 100 });
    expect(usage.costUsd).toBeCloseTo(3.75, 9);
    expect(usage.byType).toEqual([
      { type: "author", jobs: 1, costUsd: 3.5 },
      { type: "judge", jobs: 1, costUsd: 0.25 },
    ]);
    // 같은 시각이면 나중에 만든 작업이 먼저
    expect(usage.recent.map((r) => r.id)).toEqual(["job-3", "job-2", "job-1"]);
  });

  it("앱이 꺼져 남은 queued/running 작업은 실패로 정리한다", () => {
    const jobs = store();
    const a = jobs.create({ type: "author", model: "claude-opus-5-5", input: {} });
    jobs.start(a);
    const b = jobs.create({ type: "heal", model: "claude-opus-5-5", input: {} });
    expect(jobs.recoverInterrupted()).toBe(2);
    expect(jobs.get(a)).toMatchObject({ status: "failed", error: "앱이 종료되어 작업이 중단됐다" });
    expect(jobs.get(b).status).toBe("failed");
  });
});
