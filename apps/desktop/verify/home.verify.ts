import { expect, test } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseExecution } from "../../../packages/evidence/src/index";
import { fixtureDir, type FixtureName } from "../../../packages/evidence/src/test-fixtures";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYHOME_0123456789abcdefghijk";

// 홈 대시보드: 실행 기록(실제 Maestro 산출물 픽스처)과 가짜 원격 워크스페이스로 지표·추이·환경·살펴볼 테스트 케이스·최근 실행을 보고,
// 진행 중인 실행 한 건을 DB 에 넣어 "지금 진행 중" 카드가 뜨는지 본다(재생 자체는 하지 않는다). 라이트·다크
test("홈 대시보드: 지표·추이·환경·살펴볼 테스트 케이스·지금 진행 중", async () => {
  test.setTimeout(180_000);
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-home-"));
  let run = await startRun("home-empty", { userDataDir, env: remote.env });
  try {
    await doctor(run);
    await expect(run.page.getByTestId("home-tile-failing")).toContainText("-");
    await expect(run.page.getByTestId("home-trend")).toContainText("실행 기록이 쌓이면");
    await run.page.waitForTimeout(500);
    await run.shot("first");
    await run.page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await run.page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await run.page.evaluate(() => window.qa.workspace.connect());
    await run.close();

    const day = (daysAgo: number, hour: number) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    seed(userDataDir, [
      { id: "run-a", fixture: "ios-fail", tcId: "TC-0101", target: "ios", status: "failed", createdAt: day(0, 10) },
      { id: "run-b", fixture: "ios-fail", tcId: "TC-0101", target: "ios", status: "failed", createdAt: day(1, 15) },
      { id: "run-c", fixture: "ios-pass", tcId: "TC-0101", target: "ios", status: "passed", createdAt: day(2, 9) },
      { id: "run-d", fixture: "android-pass", tcId: "TC-0101", target: "android", status: "passed", createdAt: day(1, 9), flaky: true },
      { id: "run-e", fixture: "ios-pass", tcId: "TC-0002", target: "ios", status: "passed", createdAt: day(3, 11) },
      { id: "run-f", fixture: "ios-pass", tcId: "TC-0002", target: "ios", status: "passed", createdAt: day(5, 11) },
      { id: "run-g", fixture: "ios-fail", tcId: "TC-0002", target: "ios", status: "failed", createdAt: day(8, 11) },
      { id: "run-h", fixture: "ios-pass", tcId: "TC-0002", target: "ios", status: "passed", createdAt: day(10, 11) },
    ]);

    run = await startRun("home", { userDataDir, env: remote.env });
    const { page } = run;
    await doctor(run);
    await expect(page.getByTestId("home-tile-failing")).toContainText("1");
    await expect(page.getByTestId("home-tile-flaky")).toContainText("1");
    await expect(page.getByTestId("home-tile-coverage")).toContainText("2 / 2");
    await expect(page.getByTestId("home-attention-TC-0101-ios")).toContainText("2회");
    await expect(page.getByTestId("home-attention-TC-0101-android")).toContainText("재시도 통과");
    await page.waitForTimeout(500);
    await run.shot("data");
    // 막대에 올리면 그날 수가 보인다
    const today = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    await page.getByTestId(`home-trend-day-${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`).hover();
    await expect(page.getByTestId("home-trend").getByRole("status")).toContainText("실패·오류 1");
    await run.shot("trend-hover");

    // 진행 중인 실행: DB 에 한 건 넣으면 홈이 8초 안에 다시 읽어 카드를 띄운다
    const db = new DatabaseSync(join(userDataDir, "db.sqlite"));
    const startedAt = new Date(Date.now() - 42_000).toISOString();
    db.prepare("INSERT INTO run (id, workspace, trigger, status, summary, created_at, started_at) VALUES ('run-live', 'local', 'manual', 'running', ?, ?, ?)").run(
      JSON.stringify({ app: "demo", flowName: "TC-0101 이메일 회원가입", flowPath: "apps/demo/flows/ios/TC-0101.yaml", tcId: "TC-0101", target: "ios", deviceId: "dev-ios", deviceName: "Avocado iPhone 17", buildId: null, buildLabel: null, attempts: 1, flaky: false, failureMessage: null }),
      startedAt,
      startedAt,
    );
    db.close();
    await expect(page.getByTestId("home-live-run-run-live")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("home-live")).toContainText("재생 1");
    await page.waitForTimeout(500);
    await run.shot("live");
    await run.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    await run.shot("live-dark");
    // 좁은 창: 지표 2칸, 추이·환경 1단
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(400);
    await run.shot("narrow-dark");
  } finally {
    await run.close();
    await remote.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

/** 실제 산출물 픽스처로 실행 기록과 증적(가린 사본 자리)을 넣는다(e2e/results.spec.ts 의 seed 와 같다. 앱·TC 만 예시 워크스페이스에 맞춘다) */
function seed(userDataDir: string, runs: { id: string; fixture: FixtureName; tcId: string; target: "ios" | "android"; status: string; createdAt: string; flaky?: boolean }[]) {
  const db = new DatabaseSync(join(userDataDir, "db.sqlite"));
  for (const r of runs) {
    const execId = `${r.id}-e1`;
    const dir = join(userDataDir, "evidence", r.id, execId, "redacted");
    mkdirSync(dir, { recursive: true });
    cpSync(fixtureDir(r.fixture), dir, { recursive: true });
    const parsed = parseExecution({ dir });
    const summary = {
      app: "demo",
      flowName: r.tcId === "TC-0101" ? "TC-0101 이메일 회원가입" : "TC-0002 학생 계정 로그인",
      flowPath: "apps/demo/flows/ios/TC-0101.yaml",
      tcId: r.tcId,
      target: r.target,
      deviceId: `dev-${r.target}`,
      deviceName: r.target === "ios" ? "Avocado iPhone 17" : "qa_pixel_7_api35",
      buildId: null,
      buildLabel: null,
      attempts: 1,
      flaky: r.flaky ?? false,
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
    ).run(execId, r.id, r.tcId, r.target, summary.flowPath, parsed.status, parsed.durationMs, parsed.failure?.kind ?? null, parsed.failure?.message ?? null, parsed.failure?.stepIndex ?? null, `${r.id}/${execId}`, r.createdAt, r.createdAt);
    const insert = db.prepare(
      "INSERT INTO step (execution_id, idx, command, description, status, duration_ms, error, screenshot, failure_screenshot, hierarchy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of parsed.steps) insert.run(execId, s.index, s.command, s.description, s.status, s.durationMs, s.error?.message ?? null, s.screenshot, s.failureScreenshot, s.hierarchy);
  }
  db.close();
}
