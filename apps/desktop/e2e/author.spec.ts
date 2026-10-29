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
    await expect(page.getByRole("button", { name: "Claude 로 플로우 만들기" })).toBeDisabled();
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
