import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase, assertMigrationsWellFormed, DatabaseVersionError, migrate, MigrationError } from "./database";
import { EXPECTED_TABLES, MIGRATIONS } from "./migrations";

let dir: string;
let opened: AppDatabase[] = [];

function open(file = "db.sqlite") {
  const db = AppDatabase.open(join(dir, file));
  opened.push(db);
  return db;
}

const NOW = "2026-10-21T08:00:00.000Z";

function seedRun(db: DatabaseSync, id = "run-1") {
  db.prepare("INSERT INTO run (id, workspace, trigger, status, created_at) VALUES (?, 'qa-workspace', 'manual', 'running', ?)").run(id, NOW);
}
function seedExecution(db: DatabaseSync, id = "exec-1", runId = "run-1", buildId: string | null = null) {
  db.prepare(
    "INSERT INTO execution (id, run_id, tc_id, target, flow_path, build_id, status) VALUES (?, ?, 'TC-0001', 'ios', 'flows/sample/ios/TC-0001.yaml', ?, 'running')",
  ).run(id, runId, buildId);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-db-"));
  opened = [];
});
afterEach(() => {
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("마이그레이션", () => {
  it("마이그레이션 목록은 v1부터 빈틈없이 증가한다", () => {
    expect(() => assertMigrationsWellFormed(MIGRATIONS)).not.toThrow();
    expect(() => assertMigrationsWellFormed([{ version: 2, name: "x", up: "" }])).toThrow();
  });

  it("새 DB 에 최신 스키마를 만들고 계획서의 테이블을 모두 갖춘다", () => {
    const status = open().status();
    expect(status.schemaVersion).toBe(MIGRATIONS.length);
    expect(status.latestVersion).toBe(MIGRATIONS.length);
    expect(status.tables).toEqual([...EXPECTED_TABLES]);
    expect(status.journalMode).toBe("wal");
  });

  it("다시 열면 아무것도 다시 적용하지 않는다", () => {
    open().close();
    const raw = new DatabaseSync(join(dir, "db.sqlite"));
    expect(migrate(raw)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
    const rows = raw.prepare("SELECT version FROM schema_migrations").all();
    expect(rows).toHaveLength(MIGRATIONS.length);
    raw.close();
  });

  it("앱보다 새 스키마의 DB 는 열지 않는다", () => {
    open().close();
    const raw = new DatabaseSync(join(dir, "db.sqlite"));
    raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', ?)").run(NOW);
    raw.close();
    expect(() => open()).toThrow(DatabaseVersionError);
  });

  it("실패한 마이그레이션은 그 버전 전체를 되돌린다", () => {
    const broken = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, name: "broken", up: "CREATE TABLE half_done (id TEXT) STRICT; SELECT * FROM no_such_table;" },
    ];
    const raw = new DatabaseSync(join(dir, "db.sqlite"));
    expect(() => migrate(raw, broken)).toThrow(MigrationError);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("half_done");
    expect((raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(MIGRATIONS.length);
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    raw.close();
  });

  it("DB 파일은 소유자만 읽고 쓸 수 있다", () => {
    open();
    for (const name of readdirSync(dir).filter((f) => f.startsWith("db.sqlite"))) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("제약", () => {
  it("없는 실행을 가리키는 execution 은 넣을 수 없다", () => {
    const { db } = open();
    expect(() => seedExecution(db, "exec-x", "no-such-run")).toThrow(/FOREIGN KEY/);
  });

  it("run 을 지우면 execution·step·judgement·upload 가 함께 지워진다", () => {
    const { db } = open();
    seedRun(db);
    seedExecution(db);
    db.prepare("INSERT INTO step (execution_id, idx, command, status) VALUES ('exec-1', 0, '{}', 'COMPLETED')").run();
    db.prepare(
      "INSERT INTO judgement (execution_id, verdict, defects, confidence, model, created_at) VALUES ('exec-1', 'pass', '[]', 0.9, 'claude-opus-5-5', ?)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO upload (execution_id, repo, path, commit_sha, url, bytes, uploaded_at) VALUES ('exec-1', 'qa-evidence-2026', 'runs/x', 'abc', 'https://github.com/x', 10, ?)",
    ).run(NOW);
    db.prepare("DELETE FROM run WHERE id = 'run-1'").run();
    for (const table of ["execution", "step", "judgement", "upload"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });

  it("v6(빌드 테이블 다시 만들기)는 기존 빌드와 실행 기록의 빌드 연결을 지우지 않고, 외래 키를 다시 켠다", () => {
    const raw = new DatabaseSync(join(dir, "v5.sqlite"));
    migrate(raw, MIGRATIONS.slice(0, 5));
    raw.prepare(
      "INSERT INTO build (id, app, target, app_id, version, build_number, commit_sha, source, path, created_at) VALUES ('b1', 'sample', 'ios', 'com.example.sample.dev', '1.2.3', '9', 'abc1234', 'script', '/tmp/Sample.app', ?)",
    ).run(NOW);
    seedRun(raw);
    seedExecution(raw, "exec-1", "run-1", "b1");

    expect(migrate(raw)).toEqual({ from: 5, to: MIGRATIONS.length });
    expect(raw.prepare("SELECT build_id FROM execution WHERE id = 'exec-1'").get()).toEqual({ build_id: "b1" });
    expect(raw.prepare("SELECT source, commit_sha, label FROM build WHERE id = 'b1'").get()).toEqual({ source: "script", commit_sha: "abc1234", label: null });
    raw.prepare(
      "INSERT INTO build (id, app, target, app_id, version, build_number, source, path, created_at, label) VALUES ('b2', 'sample', 'ios', 'com.example.sample.dev', '1.2.4', '10', 'project', '/tmp/S2.app', ?, 'Sample · Debug')",
    ).run(NOW);
    expect((raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    // 외래 키가 다시 켜져 있어 빌드를 지우면 실행 기록의 연결만 비워진다
    raw.prepare("DELETE FROM build WHERE id = 'b1'").run();
    expect(raw.prepare("SELECT build_id FROM execution WHERE id = 'exec-1'").get()).toEqual({ build_id: null });
    raw.close();
  });

  it("빌드를 지워도 실행 기록은 남고 build_id 만 비워진다", () => {
    const { db } = open();
    db.prepare(
      "INSERT INTO build (id, app, target, app_id, version, build_number, source, path, created_at) VALUES ('b1', 'sample', 'ios', 'com.example.sample.dev', '1.2.3', '9', 'script', '/tmp/Sample.app', ?)",
    ).run(NOW);
    seedRun(db);
    seedExecution(db, "exec-1", "run-1", "b1");
    db.prepare("DELETE FROM build WHERE id = 'b1'").run();
    expect(db.prepare("SELECT build_id FROM execution WHERE id = 'exec-1'").get()).toEqual({ build_id: null });
  });

  it("허용하지 않은 상태 값과 잘못된 타입을 거부한다(CHECK, STRICT)", () => {
    const { db } = open();
    seedRun(db);
    expect(() =>
      db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status) VALUES ('e', 'run-1', 'TC', 'ios', 'f', 'great')").run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status) VALUES ('e', 'run-1', 'TC', 'web', 'f', 'queued')").run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status, duration_ms) VALUES ('e', 'run-1', 'TC', 'ios', 'f', 'queued', 'slow')").run(),
    ).toThrow();
    expect(() =>
      db.prepare(
        "INSERT INTO agent_job (id, type, status, input, model, cost_usd, created_at) VALUES ('j', 'author', 'running', '{}', 'm', -1, ?)",
      ).run(NOW),
    ).toThrow(/CHECK/);
  });
});
