import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseExecution } from "../../../packages/evidence/src/index";
import { FAKE_ACCOUNT_ID, FAKE_ACCOUNT_PW, fixtureDir, type FixtureName } from "../../../packages/evidence/src/test-fixtures";
import { startFakeGitHub } from "../../../packages/remote/src/testing/fake-github";
import { launchApp } from "./launch";

/** 실제 산출물 픽스처로 실행 기록과 증적(가린 사본 자리)을 넣는다. 기기 없이 결과 화면을 시험한다 */
function seed(userDataDir: string, runs: { id: string; fixture: FixtureName; tcId: string; flowName: string; target: "ios" | "android"; status: string; createdAt: string }[]) {
  const db = new DatabaseSync(join(userDataDir, "db.sqlite"));
  for (const r of runs) {
    const execId = `${r.id}-e1`;
    const dir = join(userDataDir, "evidence", r.id, execId, "redacted");
    mkdirSync(dir, { recursive: true });
    cpSync(fixtureDir(r.fixture), dir, { recursive: true });
    const parsed = parseExecution({ dir });
    const summary = {
      app: "settings",
      flowName: r.flowName,
      flowPath: `/flows/${r.tcId}.yaml`,
      tcId: r.tcId,
      target: r.target,
      deviceId: `dev-${r.target}`,
      deviceName: r.target === "ios" ? "QA Tool iPhone 17" : "qa_pixel_7_api35",
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
    ).run(execId, r.id, r.tcId, r.target, summary.flowPath, parsed.status, parsed.durationMs, parsed.failure?.kind ?? null, parsed.failure?.message ?? null, parsed.failure?.stepIndex ?? null, `${r.id}/${execId}`, r.createdAt, r.createdAt);
    const insert = db.prepare(
      "INSERT INTO step (execution_id, idx, command, description, status, duration_ms, error, screenshot, failure_screenshot, hierarchy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of parsed.steps) insert.run(execId, s.index, s.command, s.description, s.status, s.durationMs, s.error?.message ?? null, s.screenshot, s.failureScreenshot, s.hierarchy);
  }
  db.close();
}

test("결과 화면: 실패 실행 하나를 누르면 실패 스텝 캡처와 로그의 실패 줄이 바로 보인다", async () => {
  const first = await launchApp();
  const { userDataDir } = first;
  await first.app.close(); // DB 를 만들고 닫는다
  seed(userDataDir, [
    { id: "run-fail", fixture: "ios-fail", tcId: "TC-0101", flowName: "TC-0101 설정 검색", target: "ios", status: "failed", createdAt: "2026-10-22T01:00:00.000Z" },
    { id: "run-pass", fixture: "android-pass", tcId: "TC-0101", flowName: "TC-0101 설정 검색", target: "android", status: "passed", createdAt: "2026-10-22T00:30:00.000Z" },
  ]);

  const { app, page } = await launchApp({ userDataDir });
  // 클릭 1: 메뉴 "결과", 클릭 2: 실패한 실행
  await page.getByRole("button", { name: "결과", exact: true }).click();
  await expect(page.getByTestId("tc-cell-TC-0101-ios")).toHaveText("실패");
  await expect(page.getByTestId("tc-cell-TC-0101-android")).toHaveText("통과");
  await page.getByTestId("results-run-run-fail").click();

  await expect(page.getByTestId("results-failure")).toContainText("Element not found");
  await expect(page.getByTestId("step-5")).toHaveClass(/selected/);
  const img = page.getByTestId("capture-img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
  await expect(page.getByTestId("log-view").locator(".log-line.focus")).toContainText(/FAILED|Element not found/);
  // 로그 상자 안에서만 스크롤하고 페이지는 움직이지 않는다. 실패 줄은 상자 안에 보인다
  expect(await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0)).toBe(0);
  expect(
    await page.getByTestId("log-view").evaluate((box) => {
      const line = box.querySelector<HTMLElement>(".log-line.focus");
      return line !== null && line.offsetTop >= box.scrollTop && line.offsetTop + line.offsetHeight <= box.scrollTop + box.clientHeight;
    }),
  ).toBe(true);

  // 다른 스텝, 화면 트리, 로그 검색
  await page.getByTestId("step-4").click();
  await expect(page.getByTestId("capture-img")).toHaveAttribute("alt", /takeScreenshot 01_search_typed/);
  await page.getByTestId("step-5").click();
  await page.getByRole("button", { name: "화면 트리" }).click();
  await expect(page.getByTestId("hierarchy")).toContainText("#magnifyingglass");
  const allNodes = await page.getByTestId("hierarchy").locator("li").count();
  await page.getByLabel("트리 필터").fill("magnifying");
  const filtered = await page.getByTestId("hierarchy").locator("li").allTextContents();
  expect(filtered.length).toBeGreaterThan(0);
  expect(filtered.length).toBeLessThan(allNodes);
  expect(filtered.every((t) => t.toLowerCase().includes("magnifying"))).toBe(true);
  await page.getByLabel("로그 검색").fill("element not found");
  await page.getByRole("button", { name: "찾기" }).click();
  await expect(page.getByTestId("log-matches")).toContainText("junit.xml:");
  await page.getByTestId("log-matches").getByRole("button", { name: /console\.log:/ }).first().click();
  await expect(page.getByLabel("로그 파일")).toHaveValue("console.log");
  await expect(page.getByTestId("log-view").locator(".log-line.focus")).toContainText(/Element not found/i);

  // 통과한 Android 실행: 마지막 캡처 스텝이 기본 선택
  await page.getByTestId("tc-cell-TC-0101-android").click();
  await expect(page.getByTestId("results-detail")).toContainText("통과");
  await expect(page.getByTestId("capture-img")).toBeVisible();

  // 증적 폴더 밖·원본(raw)·다른 실행은 IPC 로도 열 수 없다
  const read = (path: string, runId = "run-fail", executionId = "run-fail-e1") =>
    page.evaluate((i) => window.qa.evidence.file(i).then(() => "accepted", (e: unknown) => String(e)), { runId, executionId, path });
  expect(await read("../../../db.sqlite")).toContain("밖의 경로");
  expect(await read("/etc/hosts")).toContain("밖의 경로");
  expect(await read("console.log", "run-pass")).toContain("찾지 못했다");

  // 실행 화면의 "결과" 버튼으로도 연다
  await page.getByRole("button", { name: "실행", exact: true }).first().click();
  await page.getByTestId("run-run-fail").getByRole("button", { name: "결과" }).click();
  await expect(page.getByTestId("results-detail")).toContainText("실패");
  await expect(page.getByTestId("capture-img")).toBeVisible();
  await app.close();
});

test("증적 올리기: 정책 스위치가 켜져야 보이고, 미리보기·개인정보 확인 뒤 한 커밋으로 올라가며 비밀 값은 없다 (T-114)", async () => {
  const year = new Date().getFullYear();
  const token = "ghp_e2e_fake_upload_token_0000000000000";
  const fake = await startFakeGitHub({ token, repos: { [`acme/qa-evidence-${year}`]: { push: true } } });
  // 보고서 주소는 github.com 형식으로 만든다(열기는 누르지 않는다)
  const env = { QA_E2E_GITHUB_API: fake.url, QA_E2E_GITHUB_WEB: "https://github.com" };
  try {
    const first = await launchApp({ env });
    const { userDataDir } = first;
    await first.app.close();
    seed(userDataDir, [{ id: "run-fail", fixture: "ios-fail", tcId: "TC-0101", flowName: "TC-0101 설정 검색", target: "ios", status: "failed", createdAt: "2026-10-22T01:00:00.000Z" }]);

    const { app, page } = await launchApp({ userDataDir, env });
    await page.evaluate(
      async ({ token, id, pw }) => {
        await window.qa.secrets.set({ name: "githubToken", value: token });
        await window.qa.secrets.set({ name: "account:settings:QA_FIXTURE_ACCOUNT_ID", value: id });
        await window.qa.secrets.set({ name: "account:settings:QA_FIXTURE_ACCOUNT_PW", value: pw });
        await window.qa.settings.update({ github: { owner: "acme" } });
      },
      { token, id: FAKE_ACCOUNT_ID, pw: FAKE_ACCOUNT_PW },
    );
    await page.getByRole("button", { name: "결과", exact: true }).click();
    await page.getByTestId("results-run-run-fail").click();
    await expect(page.getByTestId("results-detail")).toBeVisible();
    // 정책 스위치가 꺼져 있으면 기능이 없고, IPC 로도 거부된다
    await expect(page.getByTestId("evidence-upload")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.qa.evidence.prepareUpload({ runId: "run-fail", executionId: "run-fail-e1", includePassScreens: false }).then(() => "ok", (e: unknown) => String(e))),
    ).toContain("D11");

    await page.evaluate(() => window.qa.settings.update({ policy: { evidenceUploadApproved: true } }));
    await page.getByRole("button", { name: "실행", exact: true }).click();
    // 실행 목록의 각 행에도 "결과" 버튼이 있어 주 메뉴로 좁힌다
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "결과", exact: true }).click();
    await page.getByTestId("results-run-run-fail").click();
    const panel = page.getByTestId("evidence-upload");
    await panel.getByRole("button", { name: "요약 묶음 만들기" }).click();
    const preview = panel.getByTestId("upload-preview");
    await expect(preview).toContainText(`acme/qa-evidence-${year}`);
    await expect(preview).toContainText("report.md");
    await expect(preview).toContainText("logs/maestro-excerpt.txt");
    await expect(preview.locator("img").first()).toBeVisible();
    const uploadButton = panel.getByRole("button", { name: "업로드" });
    await expect(uploadButton).toBeDisabled();
    // 개인정보 확인 없이 IPC 로 올리려 해도 거부된다
    expect(await page.evaluate(() => window.qa.evidence.upload({ bundleId: "x", privacyConfirmed: false as unknown as true }).then(() => "ok", (e: unknown) => String(e)))).toContain("invalid-input");
    await panel.getByLabel(/개인정보 확인함/).check();
    await uploadButton.click();
    await expect(panel.getByTestId("upload-record")).toContainText(`https://github.com/acme/qa-evidence-${year}/blob/`);
    await expect(panel.getByTestId("upload-record")).toContainText("/runs/");

    const files = fake.files();
    const paths = [...files.keys()];
    expect(paths.some((p) => p.endsWith("/run-fail/run-fail-e1/report.md"))).toBe(true);
    expect(paths.some((p) => /\/screens\/.+\.jpg$/.test(p))).toBe(true);
    expect(paths.filter((p) => p.startsWith("index/"))).toHaveLength(1);
    const uploaded = Buffer.concat([...files.values()]).toString("latin1");
    for (const secret of [FAKE_ACCOUNT_ID, FAKE_ACCOUNT_PW, token]) expect(uploaded).not.toContain(secret);
    // 진짜 JPEG(sips 변환)
    const jpg = [...files.entries()].find(([p]) => p.endsWith(".jpg"))?.[1];
    expect(jpg?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    // 허용 목록 밖 주소는 열지 않는다
    expect(await page.evaluate(() => window.qa.app.openExternal({ url: "https://evil.example/x" }).then(() => "ok", (e: unknown) => String(e)))).toContain("허용하지 않는");
    await app.close();
  } finally {
    await fake.close();
  }
});

test("화면 판정(API 키 방식): 저장된 판정은 스텝 배지·상세로 보이고 실행 결과는 그대로다. 키가 없으면 판정하지 않는다 (T-115)", async () => {
  const first = await launchApp();
  const { userDataDir } = first;
  await first.app.close();
  seed(userDataDir, [{ id: "run-fail", fixture: "ios-fail", tcId: "TC-0101", flowName: "TC-0101 설정 검색", target: "ios", status: "failed", createdAt: "2026-10-22T01:00:00.000Z" }]);
  const db = new DatabaseSync(join(userDataDir, "db.sqlite"));
  db.prepare("INSERT INTO judgement (execution_id, step_idx, verdict, defects, confidence, model, created_at, reason) VALUES ('run-fail-e1', 5, 'fail', ?, 0.8, 'claude-opus-5-5', '2026-10-22T01:02:00.000Z', '검색 결과가 비어 있다')").run(
    JSON.stringify([{ type: "blank_screen", description: "결과 목록이 비어 있다" }]),
  );
  db.close();

  const { app, page } = await launchApp({ userDataDir });
  await page.evaluate(() => window.qa.settings.update({ agent: { provider: "api" } }));
  await page.getByRole("button", { name: "결과", exact: true }).click();
  await page.getByTestId("results-run-run-fail").click();
  await expect(page.getByTestId("judge-5")).toHaveText("판정 결함");
  await page.getByTestId("step-5").click();
  await expect(page.getByTestId("judge-detail")).toContainText("blank_screen: 결과 목록이 비어 있다");
  await expect(page.getByTestId("judge-detail")).toContainText("실행 결과에는 반영하지 않음");
  await expect(page.getByTestId("results-detail")).toContainText("실패");

  await page.getByRole("button", { name: "화면 판정", exact: true }).click();
  await expect(page.getByTestId("judge-message")).toContainText("API 키가 없다");
  await app.close();
});

// 실제 Claude 앱 대신, Claude 앱과 같은 명령(/usr/bin/nc -U <소켓>)으로 붙어 판정을 낸다(LLM 없음, ADR 0022)
test("화면 판정(Claude 앱 방식, 기본): 요청을 붙여 넣은 Claude 가 캡처를 보고 판정을 내면 배지가 생긴다 (D17)", async () => {
  const first = await launchApp();
  const { userDataDir } = first;
  await first.app.close();
  seed(userDataDir, [{ id: "run-fail", fixture: "ios-fail", tcId: "TC-0101", flowName: "TC-0101 설정 검색", target: "ios", status: "failed", createdAt: "2026-10-22T01:00:00.000Z" }]);
  const { app, page } = await launchApp({ userDataDir });
  await page.getByRole("button", { name: "결과", exact: true }).click();
  await page.getByTestId("results-run-run-fail").click();
  await page.getByRole("button", { name: "Claude 로 화면 판정" }).click();
  await expect(page.getByTestId("judge-claude-request-text")).toContainText("attach_judge");

  type ToolText = { content: { type: string; text?: string }[]; isError?: boolean };
  const textOf = (r: unknown) => (r as ToolText).content.map((c) => c.text ?? `[${c.type}]`).join("\n");
  const client = new Client({ name: "avocado-e2e", version: "1.0" });
  await client.connect(new StdioClientTransport({ command: "/usr/bin/nc", args: ["-U", join(userDataDir, "mcp", "avocado.sock")], stderr: "pipe" }));
  try {
    const attached = textOf(await client.callTool({ name: "attach_judge", arguments: {} }));
    const total = Number(/(\d+)\/\d+장 남음/.exec(attached)?.[1]);
    expect(total).toBeGreaterThan(0);
    await expect(page.getByTestId("judge-claude-request")).toContainText("avocado-e2e 1.0");
    for (let id = 1; id <= total; id += 1) {
      const capture = (await client.callTool({ name: "get_judge_capture", arguments: { captureId: id } })) as ToolText;
      expect(capture.isError).toBeFalsy();
      expect(capture.content[0]?.type).toBe("image");
      const last = id === total;
      const reply = textOf(
        await client.callTool({
          name: "submit_judgement",
          arguments: {
            captureId: id,
            blankScreen: false,
            verdict: last ? "fail" : "pass",
            defects: last ? [{ type: "wrong_screen", description: "검색 결과 대신 빈 목록" }] : [],
            confidence: 0.75,
            reason: last ? "기대한 결과가 없다" : "정상",
          },
        }),
      );
      expect(reply).toContain(last ? "모든 캡처" : "남은 캡처");
    }
  } finally {
    await client.close();
  }
  await expect(page.getByTestId("judge-message")).toContainText("Claude 판정");
  await expect(page.getByTestId("judge-claude-request")).toHaveCount(0);
  await page.getByTestId("step-5").click();
  await expect(page.getByTestId("judge-detail")).toContainText("claude-app (avocado-e2e 1.0)");
  await expect(page.getByTestId("judge-detail")).toContainText("wrong_screen: 검색 결과 대신 빈 목록");
  await expect(page.getByTestId("results-detail")).toContainText("실패");
  await app.close();
});

test("보관 표시: 결과 화면에서 켜면 다시 열어도 유지된다 (PLAN 9.1)", async () => {
  const first = await launchApp();
  const { userDataDir } = first;
  await first.app.close();
  seed(userDataDir, [{ id: "run-fail", fixture: "ios-fail", tcId: "TC-0101", flowName: "TC-0101 설정 검색", target: "ios", status: "failed", createdAt: "2026-10-22T01:00:00.000Z" }]);
  const { app, page } = await launchApp({ userDataDir });
  await page.getByRole("button", { name: "결과", exact: true }).click();
  await page.getByTestId("results-run-run-fail").click();
  const keep = page.getByTestId("keep-run");
  await expect(keep).not.toBeChecked();
  await keep.check();
  await expect(keep).toBeChecked();
  expect((await page.evaluate(() => window.qa.runs.get({ runId: "run-fail" }))).kept).toBe(true);
  await expect(page.getByTestId("evidence-removed")).toHaveCount(0);
  await app.close();
});
