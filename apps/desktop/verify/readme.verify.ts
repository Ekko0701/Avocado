import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorJobSchema } from "../../../packages/shared/src/agent";
import { DeviceListSchema } from "../../../packages/shared/src/devices";
import { makeFakeApp } from "../test-support/fake-builds";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";
import { seedRuns } from "./seed-runs";

const TOKEN = "github_pat_VERIFYREADME_0123456789abcdefghij";
/** 찍은 화면이 가는 곳. 고른 것을 docs/images 로 옮긴다 */
const OUT = join(__dirname, "../../../out/readme");
/** 앱 관리 Maestro·JRE(있으면 새 앱 데이터에 복제해 환경 점검이 정상으로 보인다) */
const TOOLS = process.env["QA_VERIFY_TOOLS"] || join(__dirname, "../../../out/e2e/real-run-userdata/tools");
const WIDTH = 1360;

// README 에 넣을 화면을 같은 크기·같은 예시 데이터로 찍는다. 기능 증명이 아니라 그림을 만드는 여정이다.
// 데이터는 예시 워크스페이스(가상 앱 Demo·Sample, 가짜 원격), 실제 Maestro 산출물 픽스처로 넣은 실행 기록, Info.plist 만 있는 가짜 빌드다.
// 실행 중인 기기 목록(devices:list), 연결된 Claude(claude:status), 플로우 만들기 작업(agent:startAuthor·authorStatus·currentAuthor)은 main 의 처리기를 바꿔 끼운다
test("readme: README 에 넣을 화면", async () => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const work = mkdtempSync(join(tmpdir(), "qa-verify-readme-"));
  const userDataDir = join(work, "userdata");
  mkdirSync(userDataDir);
  if (existsSync(TOOLS)) execFileSync("cp", ["-cR", TOOLS, join(userDataDir, "tools")]);

  // 1) 준비: 워크스페이스 연결, 테스트 계정 값, 빌드 하나
  let run = await startRun("readme-boot", { userDataDir, env: remote.env });
  try {
    await doctor(run);
    const { page } = run;
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    for (const name of ["account:demo:DEMO_TEST_PASSWORD", "account:sample:SAMPLE_TEST_STUDENT_ID", "account:sample:SAMPLE_TEST_STUDENT_PW"]) {
      await page.evaluate((n) => window.qa.secrets.set({ name: n, value: "readme-example-value" }), name);
    }
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "빌드", exact: true }).click();
    const fake = makeFakeApp(join(work, "build"), { name: "Demo", bundleId: "com.example.demo", version: "1.4.0", build: "128" });
    await page.getByLabel("앱 ID").selectOption("demo").catch(() => page.getByLabel("앱 ID").fill("demo"));
    await run.app.evaluate(({ dialog }, picked) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
    }, fake);
    await page.getByRole("button", { name: "파일로 등록" }).click();
    await expect(page.getByTestId("build-message")).toContainText("등록했습니다");
  } finally {
    await run.close();
  }

  // 2) 실행 기록: 최근 2주에 걸쳐 통과·실패
  const day = (daysAgo: number, hour: number, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const signup = { tcId: "TC-0101", title: "이메일 회원가입" };
  const login = { tcId: "TC-0002", title: "학생 계정 로그인" };
  const onboarding = { tcId: "TC-0105", title: "온보딩 첫 화면" };
  seedRuns(userDataDir, [
    { id: "run-01", fixture: "ios-fail", target: "ios", status: "failed", createdAt: day(0, 10, 12), ...signup },
    { id: "run-02", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(0, 9, 40), ...login },
    { id: "run-03", fixture: "android-pass", target: "android", status: "passed", createdAt: day(0, 9, 5), ...onboarding },
    { id: "run-04", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(1, 16, 30), ...signup },
    { id: "run-05", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(1, 11, 20), ...login },
    { id: "run-06", fixture: "android-pass", target: "android", status: "passed", createdAt: day(2, 14, 0), ...onboarding },
    { id: "run-07", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(2, 10, 0), ...signup },
    { id: "run-08", fixture: "ios-fail", target: "ios", status: "failed", createdAt: day(3, 15, 0), ...login },
    { id: "run-09", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(3, 10, 0), ...signup },
    { id: "run-10", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(4, 13, 0), ...login },
    { id: "run-11", fixture: "android-pass", target: "android", status: "passed", createdAt: day(4, 9, 0), ...onboarding },
    { id: "run-12", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(6, 11, 0), ...signup },
    { id: "run-13", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(7, 11, 0), ...login },
    { id: "run-14", fixture: "ios-fail", target: "ios", status: "failed", createdAt: day(8, 17, 0), ...signup },
    { id: "run-15", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(8, 10, 0), ...login },
    { id: "run-16", fixture: "android-pass", target: "android", status: "passed", createdAt: day(9, 10, 0), ...onboarding },
    { id: "run-17", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(10, 10, 0), ...signup },
    { id: "run-18", fixture: "ios-pass", target: "ios", status: "passed", createdAt: day(12, 10, 0), ...login },
  ]);

  // 3) 화면
  run = await startRun("readme", { userDataDir, env: remote.env });
  const { page, app } = run;
  try {
    await doctor(run);
    const cdp = await page.context().newCDPSession(page);
    /** 창 크기와 상관없이 같은 크기·2배 해상도로 찍는다 */
    const size = async (height: number) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 2, mobile: false });
      await page.waitForTimeout(500);
    };
    // Claude 데스크톱 앱이 연결된 상태로 보인다(실제 연결은 사용자의 Claude 가 있어야 한다)
    const claude = await page.evaluate(() => window.qa.claude.status());
    await app.evaluate(
      ({ ipcMain }, status) => {
        ipcMain.removeHandler("claude:status");
        ipcMain.handle("claude:status", () => status);
      },
      { ...claude, clients: [{ name: "claude-desktop", version: "1.4", connectedAt: new Date().toISOString() }] },
    );
    const snap = async (name: string, clipHeight?: number) => {
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, `${name}.png`), ...(clipHeight ? { clip: { x: 0, y: 0, width: WIDTH, height: clipHeight } } : {}) });
    };
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    const go = (name: string) => nav.getByRole("button", { name, exact: true }).click();

    await app.evaluate(
      ({ ipcMain }, list) => {
        ipcMain.removeHandler("devices:list");
        ipcMain.handle("devices:list", () => list);
      },
      DeviceListSchema.parse({
        devices: [
          { id: "5E0C7A52-1B7D-4C7E-9B1A-2F6D3C4A9E10", platform: "ios", kind: "simulator", name: "Avocado iPhone 17 (iOS 27.0)", osVersion: "27.0", state: "booted", managed: true, serial: null, locale: "ko_KR" },
          { id: "qa_pixel_7_api35", platform: "android", kind: "emulator", name: "qa_pixel_7_api35", osVersion: "15", state: "booted", managed: true, serial: "emulator-5554", locale: "ko_KR" },
        ],
        androidAvailable: true,
      }),
    );

    // 홈: 버전 줄(개발 빌드는 Electron 버전이 보인다) 위까지만
    await size(1040);
    await go("테스트 케이스");
    await go("홈");
    await expect(page.getByTestId("home-recent-run-01")).toBeVisible();
    await expect(page.getByTestId("home-env-devices")).toContainText("Avocado iPhone 17");
    await expect(page.getByTestId("home-env")).toContainText("acme/qa-workspace");
    // 환경 점검(xcodebuild·simctl)이 끝날 때까지
    await expect(page.getByTestId("home-env-tools")).not.toContainText("확인 중", { timeout: 60_000 });
    const foot = await page.locator(".home-foot").boundingBox();
    await snap("main", foot ? Math.floor(foot.y) - 4 : undefined);

    // 테스트 케이스: 양식 편집
    await size(860);
    await go("테스트 케이스");
    await page.getByTestId("tc-demo-TC-0101").click();
    await expect(page.getByTestId("tc-form")).toBeVisible();
    await snap("testcase");

    // 실행: 테스트 케이스·기기·빌드를 고른 상태
    await go("실행");
    const setup = page.getByTestId("run-setup");
    await setup.getByLabel("실행할 앱").selectOption("demo");
    await setup.getByLabel("실행할 테스트 케이스").selectOption("TC-0101");
    await setup.getByLabel("실행 기기").selectOption("5E0C7A52-1B7D-4C7E-9B1A-2F6D3C4A9E10");
    const buildId = await page.evaluate(() => window.qa.builds.list().then((b) => b[0]?.id ?? ""));
    await setup.getByLabel("실행 빌드").selectOption(buildId);
    await expect(setup.getByRole("button", { name: "테스트 케이스 실행" })).toBeEnabled();
    await snap("run");

    // 결과: 실패한 실행의 스텝·캡처·로그
    await go("결과");
    await expect(page.getByTestId("results-failure")).toBeVisible();
    await expect(page.getByTestId("log-view").locator(".log-line.focus")).toBeVisible();
    await expect(page.getByTestId("capture-img")).toBeVisible();
    await snap("results");

    // PR 작성: 테스트 케이스를 고쳐 저장하면 작업 브랜치에 커밋되고, Git 상태에서 PR 로 올린다
    await go("테스트 케이스");
    await page.getByTestId("tc-demo-TC-0101").click();
    await page.getByTestId("tc-form").getByLabel("제목").fill("이메일로 가입하면 홈 화면이 열린다");
    await page.getByLabel("변경 요약").fill("제목 다듬기");
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("에 커밋했습니다");
    await page.getByTestId("toolbar-git").click();
    const git = page.getByTestId("git-inspector");
    const branch = git.locator('[data-testid^="git-branch-"]').first();
    await branch.getByRole("button", { name: "PR 작성" }).click();
    await branch.getByRole("form", { name: "PR 작성" }).getByLabel("PR 제목").fill("TC-0101 제목 다듬기");
    await page.waitForTimeout(500);
    // Git 상태 패널만, PR 양식 아래까지
    const panel = await git.boundingBox();
    const card = await branch.boundingBox();
    if (!panel || !card) throw new Error("Git 상태 패널을 찾지 못했다");
    await page.screenshot({ path: join(OUT, "pr.png"), clip: { x: panel.x, y: panel.y, width: panel.width, height: card.y + card.height + 16 - panel.y } });
    await git.getByRole("button", { name: "main 으로 돌아가기" }).click();
    await expect(git.getByTestId("git-summary")).toContainText("main");
    await page.getByTestId("toolbar-git").click();

    // 플로우 만들기: 내 차례(요청을 Claude 에 붙여 넣기)와 기기 탐색
    await author(app, page, go, snap, buildId);
  } finally {
    await run.close();
    await remote.close();
    rmSync(work, { recursive: true, force: true });
  }
});

async function author(app: ElectronApplication, page: Page, go: (name: string) => Promise<void>, snap: (name: string) => Promise<void>, buildId: string) {
  const startedAt = new Date(Date.now() - 130_000).toISOString();
  const base = {
    job: { id: "job-7f3a2c", type: "author", status: "running", model: "claude-app", inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, error: null, createdAt: startedAt, finishedAt: null },
    app: "demo",
    tcId: "TC-0101",
    target: "ios",
    phase: "waiting_claude",
    driver: "claude-app",
    claudeRequest: "Avocado 플로우 만들기 작업 job-7f3a2c(demo TC-0101 ios)를 진행해 줘. avocado 도구의 attach_author 부터 불러.",
    claudeClient: null,
    attempt: 0,
    step: 0,
    totalSteps: 7,
    log: ["빌드를 설치한다", "maestro mcp 를 띄운다", "앱을 초기화하고 띄웠다", "기기 화면을 미리 읽었다", "Claude 를 기다린다. 요청 문장을 Claude 에 붙여 넣는다"].map((message, i) => ({
      at: new Date(Date.parse(startedAt) + i * 6000).toISOString(),
      message,
    })),
    submission: null,
    lint: [],
    replays: [],
    result: null,
  };
  const explore = ["Claude 가 작업을 맡았다: claude-desktop 1.4", "기기에서 테스트 케이스를 따라가며 플로우를 만든다", "스텝 1/7", "도구: maestro_inspect_screen", "도구: maestro_run", "스텝 2/7", "도구: maestro_run", "스텝 3/7"].map(
    (message, i) => ({ at: new Date(Date.parse(startedAt) + 40_000 + i * 8000).toISOString(), message }),
  );
  const serve = (over: Record<string, unknown>, summary: Record<string, unknown> = {}) =>
    app.evaluate(
      ({ ipcMain }, j) => {
        for (const channel of ["agent:startAuthor", "agent:authorStatus", "agent:currentAuthor"]) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => j);
        }
      },
      AuthorJobSchema.parse({ ...base, ...over, job: { ...base.job, ...summary } }),
    );
  // 테스트 케이스·기기·빌드를 고르고 시작한다(시작 처리기가 위의 작업을 돌려준다)
  await go("플로우 만들기");
  const setup = page.getByRole("region", { name: "플로우 만들기 준비" });
  await setup.getByLabel("테스트 케이스").selectOption("demo/TC-0101");
  await setup.getByLabel("기기(실행 중)").selectOption("5E0C7A52-1B7D-4C7E-9B1A-2F6D3C4A9E10");
  await setup.getByLabel("빌드(선택)").selectOption(buildId);
  await serve({});
  await setup.getByRole("button", { name: "Claude 로 플로우 만들기" }).click();
  await expect(page.getByTestId("author-step-waiting_claude")).toHaveAttribute("data-state", "mine");
  await snap("author-request");
  await serve({ phase: "exploring", attempt: 1, step: 3, claudeClient: "claude-desktop 1.4", log: [...base.log, ...explore] }, { toolCalls: 12 });
  await expect(page.getByTestId("author-step-exploring")).toHaveAttribute("data-state", "active");
  await snap("author");
}
