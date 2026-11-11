import { expect, test, type ElectronApplication } from "@playwright/test";
import { AuthorJobSchema } from "../../../packages/shared/src/agent";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYAUTHOR_0123456789abcdefghij";

// 플로우 만들기 2단 화면과 단계 표시줄: 시작 전 → 내 차례 → 기기 탐색 → 재생 실패 → 완료, 다크 모드, 좁은 창.
// 실제 작업은 부팅한 기기와 Claude 가 필요하다. 여기서는 main 의 두 처리기(agent:currentAuthor·authorStatus)가 돌려줄 작업만 바꾼다.
// 그래서 이 여정은 화면 흐름 증명이고, 플로우를 실제로 만드는 기능 증명은 아니다(author.real.test.ts)
test("author: 단계 표시줄과 단계별 화면", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("author", { env: remote.env });
  const { page, app } = run;
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
  const submission = {
    yaml: ['appId: net.example.demo', "tags:", "  - TC-0101", "---", "- runFlow: ../../subflows/ios/start.yaml", "- tapOn:", '    id: "onboarding_signup"', "- inputText: ${QA_DEMO_ACCOUNT_ID}", "- tapOn:", '    id: "signup_submit"', "- takeScreenshot: 01_home"].join("\n"),
    missingIdentifiers: [{ screenKey: "signup", description: "가입 버튼", fallbackSelector: 'text: "가입하기"' }],
    questions: ["약관 동의는 필수인가요?"],
    confidence: 0.86,
  };
  const serve = (over: Record<string, unknown>, summary: Record<string, unknown> = {}) =>
    app.evaluate(
      ({ ipcMain }, j) => {
        for (const channel of ["agent:currentAuthor", "agent:authorStatus"]) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => j);
        }
      },
      AuthorJobSchema.parse({ ...base, ...over, job: { ...base.job, ...summary } }),
    );
  const reopen = async () => {
    await page.getByRole("button", { name: "홈", exact: true }).click();
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "플로우 만들기", exact: true }).click();
  };
  try {
    run.note("doctor", await doctor(run));
    await resize(app, 1440, 900);
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());

    // 시작 전: 테스트 케이스를 고르면 타깃의 플로우가 있는지 알려 준다
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "플로우 만들기", exact: true }).click();
    const setup = page.getByRole("region", { name: "플로우 만들기 준비" });
    await setup.getByLabel("테스트 케이스").selectOption("demo/TC-0101");
    await expect(page.getByTestId("author-flow-note")).toContainText("플로우");
    run.note("flow-note", await page.getByTestId("author-flow-note").textContent());
    await run.shot("ready");

    await serve({});
    await reopen();
    await expect(page.getByTestId("author-step-waiting_claude")).toHaveAttribute("data-state", "mine");
    await expect(page.getByRole("region", { name: "플로우 만들기 준비" }).getByLabel("테스트 케이스")).toHaveValue("demo/TC-0101");
    await page.waitForTimeout(400);
    await run.shot("waiting");

    await serve({ phase: "exploring", attempt: 1, step: 3, claudeClient: "claude-desktop 1.4", log: [...base.log, ...explore] }, { toolCalls: 12 });
    await expect(page.getByTestId("author-step-exploring")).toHaveAttribute("data-state", "active");
    await page.waitForTimeout(400);
    await run.shot("exploring");

    await serve(
      {
        phase: "done",
        stoppedAt: "replaying",
        claudeRequest: null,
        attempt: 2,
        step: 7,
        claudeClient: "claude-desktop 1.4",
        submission,
        log: [...base.log, ...explore, { at: new Date().toISOString(), message: '재생 2 실패: Element not found: id "signup_submit"' }],
        replays: [{ runId: "run-a", status: "passed", flaky: false }, { runId: "run-b", status: "failed", flaky: false }],
      },
      { status: "failed", toolCalls: 44, error: '재생 2 실패: Element not found: id "signup_submit"', finishedAt: new Date().toISOString() },
    );
    await expect(page.getByTestId("author-stopped")).toBeVisible();
    await page.waitForTimeout(400);
    await run.shot("failed");

    await serve(
      {
        phase: "done",
        claudeRequest: null,
        attempt: 1,
        step: 7,
        claudeClient: "claude-desktop 1.4",
        submission,
        log: [...base.log, ...explore],
        replays: [{ runId: "run-a", status: "passed", flaky: false }, { runId: "run-b", status: "passed", flaky: false }],
        result: { flowPath: "apps/demo/flows/ios/TC-0101.yaml", branch: "qa/qa-bot/TC-0101-agent-flow", commit: "a1b2c3d4", goldenRunId: "run-b" },
      },
      { status: "succeeded", toolCalls: 31, finishedAt: new Date().toISOString() },
    );
    await reopen();
    await expect(page.getByTestId("author-result")).toBeVisible();
    await page.waitForTimeout(400);
    await run.shot("done");

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(800);
    await run.shot("done-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });

    await resize(app, 900, 760);
    await page.waitForTimeout(400);
    await run.shot("narrow");
  } finally {
    await run.close();
    await remote.close();
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}
