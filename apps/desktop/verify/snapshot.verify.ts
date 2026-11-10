import { expect, test, type ElectronApplication } from "@playwright/test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseExecution } from "../../../packages/evidence/src/index";
import { fixtureDir, type FixtureName } from "../../../packages/evidence/src/test-fixtures";
import { makeFakeApp } from "../test-support/fake-builds";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun, type VerifyRun } from "./harness";

const TOKEN = "github_pat_VERIFYSNAP_0123456789abcdefghijk";

// 화면 마크업 뜨기(읽기 전용): 사이드바의 모든 화면을 "처음 켰을 때"와 "쓰는 중"(워크스페이스·빌드·실행 기록이 있을 때)으로
// 열어 창의 마크업(.window)과 본문 높이를 남긴다. 디자인 캔버스에 지금 화면을 그대로 옮길 때 쓴다.
// 원격은 가짜 GitHub·로컬 git 이고 실행 기록은 실제 Maestro 산출물 픽스처다. 기기 화면은 이 Mac 의 실제 기기 목록을 읽는다
const PAGES: { name: string; menu: string }[] = [
  { name: "home", menu: "홈" },
  { name: "testcases", menu: "테스트 케이스" },
  { name: "author", menu: "플로우 만들기" },
  { name: "runs", menu: "실행" },
  { name: "results", menu: "결과" },
  { name: "accounts", menu: "테스트 계정" },
  { name: "devices", menu: "기기" },
  { name: "builds", menu: "빌드" },
  { name: "workspace", menu: "워크스페이스" },
  { name: "setup", menu: "설정 마법사" },
  { name: "settings", menu: "설정" },
];

test("snapshot: 모든 화면의 마크업을 빈 상태와 쓰는 중 상태로 남긴다", async () => {
  test.setTimeout(420_000);
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-snapshot-"));
  const work = mkdtempSync(join(tmpdir(), "qa-verify-snapshot-work-"));
  let run = await startRun("snapshot-empty", { userDataDir, env: remote.env });
  try {
    run.note("doctor", await doctor(run));
    for (const p of PAGES) await openAndSnapshot(run, p.menu, p.name);

    // 준비: 빌드 하나(워크스페이스 연결 전이라 앱 ID 를 직접 쓴다), 토큰·조직, 워크스페이스 연결
    const { page } = run;
    await page.getByRole("button", { name: "빌드", exact: true }).click();
    await page.getByLabel("앱 ID").fill("demo");
    await stubOpenDialog(run.app, makeFakeApp(work, { name: "Demo", bundleId: "com.example.demo.dev", version: "1.4.0", build: "128" }));
    await page.getByRole("button", { name: "파일로 등록" }).click();
    await expect(page.getByTestId("build-message")).toContainText("등록했습니다");
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await run.close();

    // 실행 기록: 실제 Maestro 산출물 픽스처(실패 1, 통과 2)
    seed(userDataDir, [
      { id: "run-fail", fixture: "ios-fail", target: "ios", status: "failed", createdAt: "2026-11-10T01:00:00.000Z" },
      { id: "run-pass-android", fixture: "android-pass", target: "android", status: "passed", createdAt: "2026-11-10T00:30:00.000Z" },
      { id: "run-pass", fixture: "ios-pass", target: "ios", status: "passed", createdAt: "2026-11-09T08:10:00.000Z" },
    ]);

    run = await startRun("snapshot-data", { userDataDir, env: remote.env });
    run.note("doctor", await doctor(run));
    for (const p of PAGES) await openAndSnapshot(run, p.menu, p.name);

    // 화면 안에서 한 번 더 들어가는 상태: 테스트 케이스 하나 열기, 실패한 실행 하나 열기
    await run.page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await run.page.getByRole("button", { name: "demo/TC-0101" }).click();
    await expect(run.page.getByTestId("tc-form")).toBeVisible();
    await snapshot(run, "testcases-open");
    await run.page.getByRole("button", { name: "결과", exact: true }).click();
    await run.page.getByTestId("results-run-run-fail").click();
    await expect(run.page.getByTestId("results-failure")).toBeVisible();
    await snapshot(run, "results-open");
  } finally {
    await run.close();
    await remote.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

async function openAndSnapshot(run: VerifyRun, menu: string, name: string) {
  await run.page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: menu, exact: true }).click();
  await expect(run.page.locator("main h1").first()).toBeVisible();
  await snapshot(run, name);
}

/** 지금 화면의 마크업(<이름>.html)·그림(<이름>-img-N.png)·크기(snapshots.jsonl)와 스크린샷을 남긴다 */
async function snapshot(run: VerifyRun, name: string) {
  // 불러오는 중 표시가 사라질 때까지 기다린다(기기 목록처럼 오래 걸리는 화면이 있다). 끝내 남으면 그대로 뜨고 기록한다
  const loading = run.page.getByText("불러오는 중");
  const settled = await loading
    .first()
    .waitFor({ state: "hidden", timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  await run.page.waitForTimeout(600);
  const data = await run.page.evaluate(() => {
    const root = document.querySelector(".window");
    if (!(root instanceof HTMLElement)) throw new Error(".window 이 없다");
    const clone = root.cloneNode(true) as HTMLElement;
    const live = [root, ...root.querySelectorAll("*")];
    const copy = [clone, ...clone.querySelectorAll("*")];
    const images: string[] = [];
    // 입력 값은 속성이 아니라 DOM 속성(property)에 있다. 마크업에 드러나게 옮긴다. 비밀번호 칸의 값은 옮기지 않는다
    live.forEach((el, i) => {
      const target = copy[i];
      if (!target) throw new Error("복제본의 요소 수가 다르다");
      if (el instanceof HTMLInputElement) {
        if (el.type === "checkbox" || el.type === "radio") target.toggleAttribute("checked", el.checked);
        else if (el.type === "password") target.removeAttribute("value");
        else target.setAttribute("value", el.value);
      } else if (el instanceof HTMLTextAreaElement) target.textContent = el.value;
      else if (el instanceof HTMLOptionElement) target.toggleAttribute("selected", el.selected);
      else if (el instanceof HTMLImageElement && el.src.startsWith("data:")) {
        target.setAttribute("src", `__IMAGE_${images.length}__`);
        images.push(el.src);
      }
    });
    const main = root.querySelector("main");
    return {
      html: clone.outerHTML,
      images,
      heading: main?.querySelector("h1")?.textContent ?? "",
      contentHeight: main?.scrollHeight ?? 0,
      sidebarHeight: root.querySelector(".sidebar-nav")?.scrollHeight ?? 0,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  writeFileSync(join(run.dir, `${name}.html`), data.html);
  const images = data.images.map((url, i) => {
    const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(url);
    if (!match?.[1] || !match[2]) throw new Error(`${name}: 그림 형식을 모른다`);
    const file = `${name}-img-${i}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
    writeFileSync(join(run.dir, file), Buffer.from(match[2], "base64"));
    return file;
  });
  appendFileSync(
    join(run.dir, "snapshots.jsonl"),
    `${JSON.stringify({ name, heading: data.heading, contentHeight: data.contentHeight, sidebarHeight: data.sidebarHeight, viewport: data.viewport, images, settled })}\n`,
  );
  await run.shot(name);
}

/** 파일 선택 창은 자동화할 수 없어 main 의 대화상자를 바꾼다(e2e/builds.spec.ts 와 같다) */
async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}

/** 실제 산출물 픽스처로 실행 기록과 증적(가린 사본 자리)을 넣는다(e2e/results.spec.ts 의 seed 와 같다. 앱·TC 만 예시 워크스페이스에 맞춘다) */
function seed(userDataDir: string, runs: { id: string; fixture: FixtureName; target: "ios" | "android"; status: string; createdAt: string }[]) {
  const db = new DatabaseSync(join(userDataDir, "db.sqlite"));
  for (const r of runs) {
    const execId = `${r.id}-e1`;
    const dir = join(userDataDir, "evidence", r.id, execId, "redacted");
    mkdirSync(dir, { recursive: true });
    cpSync(fixtureDir(r.fixture), dir, { recursive: true });
    const parsed = parseExecution({ dir });
    const summary = {
      app: "demo",
      flowName: "TC-0101 이메일 회원가입",
      flowPath: "apps/demo/flows/ios/TC-0101.yaml",
      tcId: "TC-0101",
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
