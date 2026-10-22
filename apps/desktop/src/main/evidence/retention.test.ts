import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../db/database";
import { EvidenceError, EvidenceService } from "./evidence-service";
import { EvidenceRetention } from "./retention";

let dir: string;
let db: AppDatabase;
const NOW = new Date("2026-10-22T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-retention-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
});
afterEach(() => {
  db.close();
});

function seed(id: string, opts: { finished: string | null; status?: string; keep?: boolean }) {
  db.db.prepare("INSERT INTO run (id, workspace, trigger, status, created_at, finished_at, keep) VALUES (?, 'w', 'manual', ?, ?, ?, ?)").run(id, opts.status ?? "passed", opts.finished ?? NOW.toISOString(), opts.finished, opts.keep ? 1 : 0);
  db.db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status, evidence_dir) VALUES (?, ?, 'TC-0001', 'ios', 'x', 'passed', ?)").run(`${id}-e1`, id, `${id}/${id}-e1`);
  const exec = join(dir, "evidence", id, `${id}-e1`);
  mkdirSync(join(exec, "raw"), { recursive: true });
  mkdirSync(join(exec, "redacted"), { recursive: true });
  writeFileSync(join(exec, "raw", "console.log"), "x".repeat(1000));
}

describe("로컬 증적 보관 (PLAN 9.1)", () => {
  it("보관 일수가 지난 끝난 실행의 증적만 지우고, 보관 표시·진행 중·최근 실행은 남긴다", async () => {
    seed("old", { finished: daysAgo(31) });
    seed("kept", { finished: daysAgo(90), keep: true });
    seed("recent", { finished: daysAgo(3) });
    seed("running", { finished: null, status: "running" });
    const logs: Record<string, unknown>[] = [];
    const r = new EvidenceRetention({ db, evidenceRoot: join(dir, "evidence"), retentionDays: () => 30, now: () => NOW, log: (e) => logs.push(e) });
    expect(await r.sweep()).toEqual({ runs: 1, bytes: 1000, errors: 0 });
    expect(existsSync(join(dir, "evidence", "old"))).toBe(false);
    for (const id of ["kept", "recent", "running"]) expect(existsSync(join(dir, "evidence", id)), id).toBe(true);
    expect(logs[0]).toMatchObject({ service: "evidence-retention", runs: 1, bytes: 1000 });
    // 두 번째에는 할 일이 없다
    expect(await r.sweep()).toEqual({ runs: 0, bytes: 0, errors: 0 });

    // 지운 실행의 증적을 열면 이유를 알려 준다
    const evidence = new EvidenceService({ db, evidenceRoot: join(dir, "evidence") });
    expect(() => evidence.list("old", "old-e1")).toThrow(EvidenceError);
    expect(() => evidence.list("old", "old-e1")).toThrow("보관 기간이 지나");
  });

  it("실행 폴더가 심볼릭 링크면 링크만 지우고 대상은 건드리지 않는다", async () => {
    const outside = mkdtempSync(join(tmpdir(), "qa-outside-"));
    writeFileSync(join(outside, "keep.txt"), "important");
    db.db.prepare("INSERT INTO run (id, workspace, trigger, status, created_at, finished_at) VALUES ('link', 'w', 'manual', 'passed', ?, ?)").run(daysAgo(40), daysAgo(40));
    mkdirSync(join(dir, "evidence"), { recursive: true });
    symlinkSync(outside, join(dir, "evidence", "link"));
    await new EvidenceRetention({ db, evidenceRoot: join(dir, "evidence"), retentionDays: () => 30, now: () => NOW }).sweep();
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "link"))).toBe(false);
  });
});
