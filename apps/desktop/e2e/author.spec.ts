import { expect, test } from "@playwright/test";
import { AuthorJobSchema } from "../../../packages/shared/src/agent";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2EAUTHOR_0123456789abcdefghijklmnopq";

test("플로우 만들기: 화면을 다시 열면 진행 중인 작업을 이어 보이고, 그 TC 를 저장하면 경고한다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    // Claude 를 기다리는 TC-0101 작업. 실제 작업은 부팅한 기기가 필요해 main 의 두 처리기만 이 작업을 돌려주게 바꾼다
    const job = AuthorJobSchema.parse({
      job: { id: "job-e2e", type: "author", status: "running", model: "claude-app", inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, error: null, createdAt: "2026-10-22T08:00:00.000Z", finishedAt: null },
      app: "demo",
      tcId: "TC-0101",
      target: "ios",
      phase: "waiting_claude",
      driver: "claude-app",
      claudeRequest: "Avocado 플로우 만들기 작업 job-e2e(demo TC-0101 ios)를 진행해 줘. avocado 도구의 attach_author 부터 불러.",
      claudeClient: null,
      attempt: 0,
      step: 0,
      totalSteps: 2,
      log: [],
      submission: null,
      lint: [],
      replays: [],
      result: null,
    });
    await app.evaluate(({ ipcMain }, j) => {
      for (const channel of ["agent:currentAuthor", "agent:authorStatus"]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => j);
      }
    }, job);

    // 화면을 열면(다른 화면에 갔다 와도) 진행 중인 작업과 Claude 에 붙여 넣을 요청이 보인다
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "플로우 만들기", exact: true }).click();
    await expect(page.getByTestId("author-job")).toBeVisible();
    await expect(page.getByTestId("author-claude-request-text")).toContainText("job-e2e");
    // 진행 중에는 시작 버튼 자리에 취소가 있고, 고르는 칸은 잠긴다
    await expect(page.getByRole("button", { name: "Claude 로 플로우 만들기" })).toHaveCount(0);
    const setup = page.getByRole("region", { name: "플로우 만들기 준비" });
    await expect(setup.getByRole("button", { name: "취소" })).toBeVisible();
    await expect(setup.getByLabel("테스트 케이스")).toBeDisabled();
    await expect(setup.getByLabel("테스트 케이스")).toHaveValue("demo/TC-0101");
    await expect(setup.getByRole("tab", { name: "iOS" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("author-meta")).toContainText("이메일로 회원가입하면 홈 화면이 열린다");
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await nav.getByRole("button", { name: "플로우 만들기", exact: true }).click();
    await expect(page.getByTestId("author-claude-request-text")).toContainText("job-e2e");

    // 작업 중인 TC 를 열면 경고가 보이고, 확인하지 않으면 저장하지 않는다
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await page.getByRole("button", { name: "demo/TC-0101" }).click();
    const warning = page.getByTestId("tc-authoring-warning");
    await expect(warning).toContainText("플로우 만들기가 진행 중입니다");
    await page.getByTestId("tc-form").getByLabel("제목").fill("이메일로 가입하면 홈 화면이 열린다");
    await page.getByLabel("변경 요약").fill("title wording");
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("아래 경고를 확인한 뒤 저장합니다");
    await warning.getByRole("checkbox").check();
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0101-title-wording 에 커밋했습니다");

    // 다른 TC 에는 경고가 없다
    await page.getByRole("button", { name: "sample/TC-0002" }).click();
    await expect(page.getByRole("heading", { name: /sample\/TC-0002/ })).toBeVisible();
    await expect(page.getByTestId("tc-authoring-warning")).toHaveCount(0);
    await app.close();
  } finally {
    await remote.close();
  }
});

test("플로우 만들기: 단계 표시줄이 내 차례 → 탐색 → 재생 실패 → 완료를 따라가고, 끝나면 다음 행동이 보인다", async () => {
  const { app, page } = await launchApp();
  const base = {
    job: { id: "job-steps", type: "author", status: "running", model: "claude-app", inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, error: null, createdAt: new Date().toISOString(), finishedAt: null },
    app: "demo",
    tcId: "TC-0101",
    target: "android",
    phase: "waiting_claude",
    driver: "claude-app",
    claudeRequest: "Avocado 플로우 만들기 작업 job-steps(demo TC-0101 android)를 진행해 줘. avocado 도구의 attach_author 부터 불러.",
    claudeClient: null,
    attempt: 0,
    step: 0,
    totalSteps: 7,
    log: [{ at: "2026-11-10T01:02:41.000Z", message: "Claude 를 기다린다. 요청 문장을 Claude 에 붙여 넣는다" }],
    submission: null,
    lint: [],
    replays: [],
    result: null,
  };
  // 실제 작업은 부팅한 기기와 Claude 가 필요해 main 의 두 처리기가 돌려줄 작업만 바꾼다(화면 흐름 확인)
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
  const step = (phase: string) => page.getByTestId(`author-step-${phase}`);
  const submission = { yaml: "appId: net.example.demo\n---\n- launchApp", missingIdentifiers: [{ screenKey: "signup", description: "가입 버튼", fallbackSelector: 'text: "가입하기"' }], questions: ["약관 동의는 필수인가요?"], confidence: 0.86 };

  // 시작 전: 진행 순서 안내와 대기 단계 6개
  await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
  await expect(page.getByTestId("author-intro")).toContainText("이렇게 진행됩니다");
  await expect(page.getByTestId("author-steps").getByRole("listitem")).toHaveCount(6);
  await expect(step("waiting_claude")).toHaveAttribute("data-state", "pending");

  // 2단계 내 차례: 요청과 복사 버튼이 안내 판에 있다
  await serve({});
  await page.getByRole("button", { name: "홈", exact: true }).click();
  await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
  await expect(step("preparing")).toHaveAttribute("data-state", "done");
  await expect(step("waiting_claude")).toHaveAttribute("data-state", "mine");
  await expect(step("waiting_claude")).toContainText("내 차례");
  const request = page.getByTestId("author-claude-request");
  await expect(request).toContainText("Claude 에 이 요청을 붙여 넣으세요");
  await expect(request.getByRole("button", { name: "요청 복사" })).toBeVisible();
  await expect(page.getByTestId("author-log")).toContainText("Claude 를 기다린다");

  // 3단계 탐색: 스텝 진행과 다시 복사
  await serve({ phase: "exploring", attempt: 1, step: 3, claudeClient: "claude-desktop 1.4" }, { toolCalls: 12 });
  await expect(step("exploring")).toHaveAttribute("data-state", "active");
  await expect(step("exploring")).toContainText("스텝 3/7");
  await expect(page.getByRole("progressbar", { name: "테스트 케이스 스텝 진행" })).toHaveAttribute("aria-valuenow", "3");
  await expect(page.getByTestId("author-meta")).toContainText("도구 12회");
  await expect(page.getByRole("button", { name: "요청 다시 복사" })).toBeVisible();
  await expect(page.getByTestId("author-claude-request")).toHaveCount(0);

  // 재생 실패: 멈춘 단계가 빨강, 이유와 실패한 재생 보기·다시 만들기
  await serve(
    { phase: "done", stoppedAt: "replaying", claudeRequest: null, attempt: 2, step: 7, submission, replays: [{ runId: "run-a", status: "passed", flaky: false }, { runId: "run-b", status: "failed", flaky: false }] },
    { status: "failed", error: '재생 2 실패: Element not found: id "signup_submit"', finishedAt: new Date().toISOString() },
  );
  await expect(step("replaying")).toHaveAttribute("data-state", "failed");
  await expect(step("replaying")).toContainText("2번 실패");
  await expect(step("saving")).toContainText("하지 않음");
  const stopped = page.getByTestId("author-stopped");
  await expect(stopped).toContainText("재생에서 실패해 저장하지 않았습니다");
  await expect(stopped.getByRole("alert")).toContainText("signup_submit");
  await expect(stopped.getByRole("button", { name: "실패한 재생 보기" })).toBeVisible();
  await expect(page.getByTestId("author-replays")).toContainText("2번 실패");
  // 끝나면 초안 탭이 먼저 보이고, 누락·질문은 탭에 수와 함께 있다
  await expect(page.getByTestId("author-draft")).toContainText("appId: net.example.demo");
  const tabs = page.getByRole("tablist", { name: "만든 결과" });
  await tabs.getByRole("tab", { name: "식별자 누락 1" }).click();
  await expect(page.getByRole("cell", { name: "가입 버튼" })).toBeVisible();
  await tabs.getByRole("tab", { name: "기획자 질문 1" }).click();
  await expect(page.getByText("약관 동의는 필수인가요?")).toBeVisible();
  // 다시 만들기: 왼쪽을 그 작업의 테스트 케이스·타깃에 맞추고 기기를 고르게 한다
  await stopped.getByRole("button", { name: "다시 만들기" }).click();
  await expect(page.getByRole("region", { name: "플로우 만들기 준비" }).getByRole("tab", { name: "Android" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("author-message")).toContainText("기기를 확인한 뒤 다시 시작합니다");

  // 완료: 모든 단계가 끝, 커밋 결과와 PR 작성·골든 런 보기
  await serve(
    {
      phase: "done",
      claudeRequest: null,
      attempt: 1,
      step: 7,
      submission,
      replays: [{ runId: "run-a", status: "passed", flaky: false }, { runId: "run-b", status: "passed", flaky: false }],
      result: { flowPath: "apps/demo/flows/android/TC-0101.yaml", branch: "qa/qa-bot/TC-0101-agent-flow", commit: "a1b2c3d4", goldenRunId: "run-b" },
    },
    { status: "succeeded", finishedAt: new Date().toISOString() },
  );
  await page.getByRole("button", { name: "홈", exact: true }).click();
  await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
  for (const phase of ["preparing", "waiting_claude", "exploring", "checking", "replaying", "saving"]) await expect(step(phase)).toHaveAttribute("data-state", "done");
  await expect(step("saving")).toContainText("a1b2c3d");
  const result = page.getByTestId("author-result");
  await expect(result).toContainText("플로우를 만들어 작업 브랜치에 커밋했습니다");
  await expect(result).toContainText("qa/qa-bot/TC-0101-agent-flow");
  await expect(result.getByRole("button", { name: "PR 작성" })).toBeVisible();
  await expect(page.getByTestId("author-stopped")).toHaveCount(0);
  // 골든 런 보기는 결과 화면으로 간다
  await result.getByRole("button", { name: "골든 런 보기" }).click();
  await expect(page.getByRole("heading", { name: "결과", level: 1 })).toBeVisible();
  await app.close();
});

test("플로우 만들기(Claude 앱 방식, 기본): 키 없이 준비하고, 기기가 없으면 시작하지 않는다 (D17)", async () => {
  const { app, page } = await launchApp();
  await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "플로우 만들기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claude 로 플로우 만들기" })).toBeDisabled();
  await expect(page.getByTestId("author-no-key")).toHaveCount(0);
  await expect(page.getByText("Claude 요금제 한도 사용")).toBeVisible();
  const call = (input: unknown) =>
    page.evaluate((i) => window.qa.agent.startAuthor(i as never).then(() => "accepted", (e: unknown) => String(e)), input);
  // 키를 묻지 않고 기기부터 확인한다
  expect(await call({ app: "demo", tcId: "TC-0101", target: "ios", deviceId: "no-such-device", buildId: null })).toContain("기기를 찾지 못했다");
  await app.close();
});

test("플로우 만들기(API 키 방식): 키가 없으면 시작할 수 없고, main 이 잘못된 요청과 조건 미충족을 거부한다 (T-113)", async () => {
  const { app, page } = await launchApp();
  await page.evaluate(() => window.qa.settings.update({ agent: { provider: "api" } }));
  await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "플로우 만들기" })).toBeVisible();
  await expect(page.getByTestId("author-no-key")).toBeVisible();
  await expect(page.getByRole("button", { name: "플로우 만들기" }).nth(1)).toBeDisabled();

  const call = (input: unknown) =>
    page.evaluate((i) => window.qa.agent.startAuthor(i as never).then(() => "accepted", (e: unknown) => String(e)), input);
  // 형식이 틀린 입력(경로 같은 TC id, 덧붙인 필드)은 검증에서 막힌다
  expect(await call({ app: "demo", tcId: "../../etc", target: "ios", deviceId: "x", buildId: null })).toContain("invalid-input");
  expect(await call({ app: "demo", tcId: "TC-0101", target: "ios", deviceId: "x", buildId: null, model: "other" })).toContain("invalid-input");
  // 키가 없으면 시작하지 않는다
  expect(await call({ app: "demo", tcId: "TC-0101", target: "ios", deviceId: "x", buildId: null })).toContain("Anthropic API 키가 없다");

  // 키를 저장해도 기기가 없으면 시작하지 않는다(실제 API 호출 없음)
  await page.evaluate(() => window.qa.secrets.set({ name: "anthropicApiKey", value: "sk-ant-e2e-not-a-real-key" }));
  expect(await call({ app: "demo", tcId: "TC-0101", target: "ios", deviceId: "no-such-device", buildId: null })).toContain("기기를 찾지 못했다");
  expect(await page.evaluate(() => window.qa.agent.authorStatus({ jobId: "nope" }).then(() => "ok", (e: unknown) => String(e)))).toContain("에이전트 작업을 찾지 못했다");

  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
  await expect(page.getByTestId("author-no-key")).toHaveCount(0);
  await app.close();
});
