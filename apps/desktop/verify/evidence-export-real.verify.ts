import { expect, test } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { doctor, startRun } from "./harness";

// 증적 폴더로 내보내기(T-126, ADR 0036 결정 9) 실제 확인: 실제 Maestro 실행의 기록과 증적(가린 사본)을 새 앱 데이터에 복제해
// 로컬 워크스페이스·정책 꺼짐 상태로 띄우고, 결과 화면에서 폴더로 내보낸 뒤 보고서를 연다. 기기는 켜지 않는다.
//   QA_VERIFY_REAL_USERDATA  실제 실행이 남은 앱 데이터(기본 out/e2e/real-run-userdata). 읽기만 한다
//   QA_VERIFY_REAL_RUN       내보낼 실행 id(기본 가장 최근에 끝난 실행)
// 폴더 고르기 창만 바꿔 끼워 증적 폴더 안의 export/ 를 고른다
const SOURCE = process.env["QA_VERIFY_REAL_USERDATA"] || join(__dirname, "../../../out/e2e/real-run-userdata");

test("증적 폴더로 내보내기: 실제 실행 한 건을 결과 화면에서 내보내고 보고서를 연다", async () => {
  test.setTimeout(5 * 60_000);
  if (!existsSync(join(SOURCE, "db.sqlite"))) throw new Error(`실제 실행 앱 데이터가 없다: ${SOURCE}`);
  const source = new DatabaseSync(join(SOURCE, "db.sqlite"), { readOnly: true });
  const runId =
    process.env["QA_VERIFY_REAL_RUN"] ||
    (source.prepare("SELECT id FROM run WHERE status IN ('passed', 'failed') ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined)?.id;
  if (!runId) throw new Error("끝난 실행이 없다");
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-evidence-export-"));
  source.exec(`VACUUM INTO '${join(userDataDir, "db.sqlite").replaceAll("'", "''")}'`);
  source.close();
  cpSync(join(SOURCE, "evidence", runId), join(userDataDir, "evidence", runId), { recursive: true });
  if (existsSync(join(SOURCE, "secrets.json"))) cpSync(join(SOURCE, "secrets.json"), join(userDataDir, "secrets.json"));

  const run = await startRun("evidence-export-real", { userDataDir, workspaceSource: "local" });
  try {
    run.note("doctor", await doctor(run));
    run.note("source", { runId, settings: await run.page.evaluate(() => window.qa.settings.get().then((s) => ({ policy: s.settings.policy, owner: s.settings.github.owner }))) });
    const target = join(run.dir, "export");
    mkdirSync(target);
    await run.app.evaluate(({ dialog }, picked) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
    }, target);

    await run.page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "결과", exact: true }).click();
    await run.page.getByTestId(`results-run-${runId}`).click();
    await expect(run.page.getByTestId("results-detail")).toBeVisible();
    await run.page.getByRole("tablist", { name: "증적" }).getByRole("tab", { name: "폴더로 내보내기" }).click();
    const panel = run.page.getByTestId("evidence-export");
    await run.shot("export-tab");
    await panel.getByRole("button", { name: "요약 묶음 만들기" }).click();
    const preview = panel.getByTestId("export-preview");
    await expect(preview).toContainText("report.md");
    await expect(panel.getByRole("button", { name: "폴더로 내보내기…" })).toBeDisabled();
    await panel.getByRole("button", { name: "폴더로 내보내기…" }).scrollIntoViewIfNeeded();
    await run.shot("preview");
    await panel.getByLabel(/개인정보 확인함/).check();
    await panel.getByRole("button", { name: "폴더로 내보내기…" }).click();
    await expect(panel.getByTestId("export-record")).toBeVisible();
    await panel.getByTestId("export-message").scrollIntoViewIfNeeded();
    await run.shot("exported");

    const [folderName] = readdirSync(target);
    expect(folderName).toMatch(/^avocado-evidence-/);
    const folder = join(target, folderName ?? "");
    const files = readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    const report = readFileSync(join(folder, "report.md"), "utf8");
    run.note("exported", { folder, files: files.map((f) => `${f.slice(folder.length + 1)} ${readFileSync(f).length}`) });
    run.note("report.md", report);
    const jpgs = files.filter((f) => f.endsWith(".jpg"));
    expect(jpgs.length).toBeGreaterThan(0);
    for (const f of jpgs) expect(readFileSync(f).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), f).toBe(true);
    const text = files.filter((f) => !f.endsWith(".jpg")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(text).not.toContain(homedir());
    expect(report).toContain(runId);
    expect(report).toContain("원본 증적과 영상은 넣지 않았습니다");
  } finally {
    await run.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
