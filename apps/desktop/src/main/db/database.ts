import type { DbStatus } from "@qa/shared";
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations";

/**
 * 로컬 SQLite (PLAN 3.5, 5장, ADR 0005).
 * Electron 44 에 들어 있는 Node 24 의 내장 node:sqlite 를 쓴다. 네이티브 모듈이 없어 패키징 재빌드가 필요 없다.
 */

export class DatabaseVersionError extends Error {
  constructor(
    readonly found: number,
    readonly latest: number,
  ) {
    super(`DB 스키마 v${found}이 이 앱이 아는 최신 v${latest}보다 새롭다. 앱을 최신 버전으로 업데이트해야 한다`);
    this.name = "DatabaseVersionError";
  }
}

export class MigrationError extends Error {
  constructor(
    readonly migration: Pick<Migration, "version" | "name">,
    cause: unknown,
  ) {
    super(`마이그레이션 v${migration.version}(${migration.name}) 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MigrationError";
  }
}

export function assertMigrationsWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`마이그레이션 버전은 1부터 빈틈없이 증가해야 한다: ${i}번째가 v${m.version}`);
  });
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  return row.v;
}

/** 각 버전을 트랜잭션 하나로 적용한다. 실패하면 그 버전 전체를 롤백한다. */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): { from: number; to: number } {
  assertMigrationsWellFormed(migrations);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT",
  );
  const from = currentVersion(db);
  const latest = migrations.length;
  if (from > latest) throw new DatabaseVersionError(from, latest);

  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of migrations.slice(from)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.up);
      record.run(migration.version, migration.name, now().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new MigrationError(migration, error);
    }
  }
  return { from, to: latest };
}

export class AppDatabase {
  private constructor(
    readonly path: string,
    readonly db: DatabaseSync,
  ) {}

  /**
   * DB 를 열고 마이그레이션한다.
   * - 파일 권한 0600 (WAL·SHM 파일도 같은 권한으로 만들어진다)
   * - WAL, 외래 키, busy_timeout
   */
  static open(path: string, migrations: readonly Migration[] = MIGRATIONS): AppDatabase {
    const isNew = path !== ":memory:" && !existsSync(path);
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      if (isNew) chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout = 5000");
      if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db, migrations);
    } catch (error) {
      db.close();
      throw error;
    }
    return new AppDatabase(path, db);
  }

  status(): DbStatus {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return {
      path: this.path,
      schemaVersion: currentVersion(this.db),
      latestVersion: MIGRATIONS.length,
      journalMode: journal.journal_mode,
      tables: tables.map((t) => t.name),
    };
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
