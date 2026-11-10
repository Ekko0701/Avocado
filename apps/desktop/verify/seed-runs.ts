import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseExecution } from "../../../packages/evidence/src/index";
import { fixtureDir, type FixtureName } from "../../../packages/evidence/src/test-fixtures";

/** 실제 산출물 픽스처로 실행 기록과 증적(가린 사본 자리)을 넣는다(e2e/results.spec.ts 의 seed 와 같다. 앱·TC 는 예시 워크스페이스에 맞추고, 테스트 케이스를 바꿔 넣을 수 있다) */
export function seedRuns(userDataDir: string, runs: { id: string; fixture: FixtureName; target: "ios" | "android"; status: string; createdAt: string; tcId?: string; title?: string }[]) {
  const db = new DatabaseSync(join(userDataDir, "db.sqlite"));
  for (const r of runs) {
    const execId = `${r.id}-e1`;
    const dir = join(userDataDir, "evidence", r.id, execId, "redacted");
    mkdirSync(dir, { recursive: true });
    cpSync(fixtureDir(r.fixture), dir, { recursive: true });
    const parsed = parseExecution({ dir });
    const summary = {
      app: "demo",
      flowName: `${r.tcId ?? "TC-0101"} ${r.title ?? "이메일 회원가입"}`,
      flowPath: `apps/demo/flows/${r.target}/${r.tcId ?? "TC-0101"}.yaml`,
      tcId: r.tcId ?? "TC-0101",
      target: r.target,
      deviceId: `dev-${r.target}`,
      deviceName: r.target === "ios" ? "Avocado iPhone 17" : "qa_pixel_7_api35",
      buildId: null,
      buildLabel: null,
      attempts: 1,
      flaky: false,
      failureMessage: parsed.failure?.message ?? null,
    };
    db.prepare("INSERT INTO run (id, workspace, trigger, status, summary, created_at, started_at, finished_at) VALUES (?, 'local', 'manual', ?, ?, ?, ?, ?)").run(
      r.id,
      r.status,
      JSON.stringify(summary),
      r.createdAt,
      r.createdAt,
      r.createdAt,
    );
    db.prepare(
      `INSERT INTO execution (id, run_id, tc_id, target, flow_path, attempt, status, duration_ms, failure_kind, failure_message, failure_step, evidence_dir, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(execId, r.id, summary.tcId, r.target, summary.flowPath, parsed.status, parsed.durationMs, parsed.failure?.kind ?? null, parsed.failure?.message ?? null, parsed.failure?.stepIndex ?? null, `${r.id}/${execId}`, r.createdAt, r.createdAt);
    const insert = db.prepare(
      "INSERT INTO step (execution_id, idx, command, description, status, duration_ms, error, screenshot, failure_screenshot, hierarchy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of parsed.steps) insert.run(execId, s.index, s.command, s.description, s.status, s.durationMs, s.error?.message ?? null, s.screenshot, s.failureScreenshot, s.hierarchy);
  }
  db.close();
}
