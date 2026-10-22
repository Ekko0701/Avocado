/**
 * 로컬 SQLite 스키마 마이그레이션 (PLAN 5장).
 * - 버전은 1부터 빈틈없이 증가한다. 이미 배포한 마이그레이션은 고치지 않고 새 버전을 추가한다.
 * - 모든 테이블은 STRICT(타입 강제)다. 시각은 ISO 8601 UTC 문자열, JSON 은 TEXT 로 저장한다.
 * - TC·플로우·화면 그래프는 워크스페이스 파일이 원본이라 여기 두지 않는다. DB 는 실행 기록과 색인만 둔다.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

const V1_INITIAL = `
CREATE TABLE build (
  id            TEXT PRIMARY KEY,
  app           TEXT NOT NULL,
  target        TEXT NOT NULL CHECK (target IN ('ios', 'android')),
  app_id        TEXT NOT NULL,
  version       TEXT NOT NULL,
  build_number  TEXT NOT NULL,
  commit_sha    TEXT,
  source        TEXT NOT NULL CHECK (source IN ('file', 'script')),
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE device (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('simulator', 'emulator', 'real')),
  os          TEXT NOT NULL CHECK (os IN ('ios', 'android')),
  os_version  TEXT NOT NULL,
  name        TEXT NOT NULL,
  locale      TEXT,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE run (
  id                TEXT PRIMARY KEY,
  workspace         TEXT NOT NULL,
  workspace_commit  TEXT,
  trigger           TEXT NOT NULL CHECK (trigger IN ('manual', 'author', 'schedule')),
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'canceled')),
  summary           TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
) STRICT;
CREATE INDEX idx_run_created ON run (created_at);

CREATE TABLE execution (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  tc_id          TEXT NOT NULL,
  target         TEXT NOT NULL CHECK (target IN ('ios', 'android')),
  flow_path      TEXT NOT NULL,
  flow_blob      TEXT,
  build_id       TEXT REFERENCES build (id) ON DELETE SET NULL,
  device_id      TEXT REFERENCES device (id) ON DELETE SET NULL,
  attempt        INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'skipped')),
  duration_ms    INTEGER CHECK (duration_ms >= 0),
  failure_class  TEXT CHECK (failure_class IN ('app_bug', 'test_drift', 'env_issue', 'flaky', 'unknown')),
  evidence_dir   TEXT,
  host_load      REAL,
  started_at     TEXT,
  finished_at    TEXT
) STRICT;
CREATE INDEX idx_execution_run ON execution (run_id);
CREATE INDEX idx_execution_tc ON execution (tc_id, target, started_at);

CREATE TABLE step (
  execution_id  TEXT NOT NULL REFERENCES execution (id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL CHECK (idx >= 0),
  command       TEXT NOT NULL,
  status        TEXT NOT NULL,
  duration_ms   INTEGER CHECK (duration_ms >= 0),
  error         TEXT,
  screenshot    TEXT,
  hierarchy     TEXT,
  screen_key    TEXT,
  PRIMARY KEY (execution_id, idx)
) STRICT;

CREATE TABLE agent_job (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL CHECK (type IN ('author', 'heal', 'judge', 'explore')),
  status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'budget_exceeded')),
  input              TEXT NOT NULL,
  output             TEXT,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cost_usd           REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  transcript_path    TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT
) STRICT;
CREATE INDEX idx_agent_job_created ON agent_job (created_at);

CREATE TABLE judgement (
  id            INTEGER PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES execution (id) ON DELETE CASCADE,
  step_idx      INTEGER,
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'uncertain')),
  defects       TEXT NOT NULL,
  confidence    REAL CHECK (confidence BETWEEN 0 AND 1),
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_judgement_execution ON judgement (execution_id);

CREATE TABLE upload (
  id            INTEGER PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES execution (id) ON DELETE CASCADE,
  repo          TEXT NOT NULL,
  path          TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  url           TEXT NOT NULL,
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  uploaded_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_upload_execution ON upload (execution_id);
`;

/**
 * v2 (T-107): 결과 화면(T-108)이 실패 원인과 스텝 설명을 파일을 다시 읽지 않고 보여 주도록 실행·스텝 열을 더한다.
 * 실패 종류는 packages/evidence 의 종류 + canceled(사용자 취소), internal(앱 내부 오류).
 */
const V2_RUN_RESULTS = `
ALTER TABLE execution ADD COLUMN failure_kind TEXT
  CHECK (failure_kind IN ('step_failed', 'driver_start', 'flow_error', 'interrupted', 'no_result', 'canceled', 'internal'));
ALTER TABLE execution ADD COLUMN failure_message TEXT;
ALTER TABLE execution ADD COLUMN failure_step INTEGER CHECK (failure_step >= 0);
ALTER TABLE execution ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
ALTER TABLE step ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE step ADD COLUMN failure_screenshot TEXT;
`;

/** T-112: 캐시 쓰기 토큰(비용 계산에 들어간다), 도구 호출 수, 실패 이유 */
const V3_AGENT_JOB_USAGE = `
ALTER TABLE agent_job ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0);
ALTER TABLE agent_job ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0);
ALTER TABLE agent_job ADD COLUMN error TEXT;
`;

/** T-115: 판정 근거 */
const V4_JUDGEMENT_REASON = `
ALTER TABLE judgement ADD COLUMN reason TEXT;
`;

/** T-114(PLAN 9.1): 보관 표시와 보관 기간이 지나 증적을 지운 시각 */
const V5_EVIDENCE_RETENTION = `
ALTER TABLE run ADD COLUMN keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1));
ALTER TABLE run ADD COLUMN evidence_removed_at TEXT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", up: V1_INITIAL },
  { version: 2, name: "run results", up: V2_RUN_RESULTS },
  { version: 3, name: "agent job usage", up: V3_AGENT_JOB_USAGE },
  { version: 4, name: "judgement reason", up: V4_JUDGEMENT_REASON },
  { version: 5, name: "evidence retention", up: V5_EVIDENCE_RETENTION },
];

/** 앱이 기대하는 테이블 목록(마이그레이션 기록 테이블 포함). 테스트와 상태 표시에 쓴다. */
export const EXPECTED_TABLES = [
  "agent_job",
  "build",
  "device",
  "execution",
  "judgement",
  "run",
  "schema_migrations",
  "step",
  "upload",
] as const;
