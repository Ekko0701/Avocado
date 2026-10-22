import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const SECRET = "sk-ant-E2E-SECRET-MUST-NOT-LEAK-42";
const ACCOUNT_VALUE = "e2e-account-password-777";

function readDirRecursive(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return readDirRecursive(path);
      return readFileSync(path).toString("latin1");
    })
    .join("\n");
}

test("비밀 저장: 상태만 보이고 값은 화면·파일 어디에도 없으며 재시작 후에도 유지된다", async () => {
  const first = await launchApp();
  const { page, userDataDir } = first;
  await page.getByRole("button", { name: "설정", exact: true }).click();
  // 기본(Claude 앱 방식)에서는 Anthropic API 키를 묻지 않는다. API 키 방식을 고르면 나온다(D17)
  await expect(page.getByTestId("secret-anthropicApiKey")).toHaveCount(0);
  await page.getByTestId("claude-connection").getByRole("radio", { name: /Anthropic API 키/ }).check();

  const row = page.getByTestId("secret-anthropicApiKey");
  await expect(row.getByTestId("secret-status")).toHaveText("저장 안 됨");
  await row.getByLabel("Anthropic API 키 입력").fill(SECRET);
  await row.getByRole("button", { name: "저장" }).click();
  await expect(row.getByTestId("secret-status")).toHaveText("저장됨");
  await expect(row.getByLabel("Anthropic API 키 입력")).toHaveValue("");

  // 테스트 계정 값 추가
  const add = page.getByRole("form", { name: "테스트 계정 값 추가" });
  await add.getByLabel("앱 ID").fill("sample");
  await add.getByLabel("키 이름").fill("SAMPLE_TEST_STUDENT_PW");
  await add.getByLabel("값").fill(ACCOUNT_VALUE);
  await add.getByRole("button", { name: "추가" }).click();
  await expect(page.getByTestId("secret-account:sample:SAMPLE_TEST_STUDENT_PW").getByTestId("secret-status")).toHaveText(
    "저장됨",
  );

  // 화면(DOM 전체)에 값이 없다
  const html = await page.content();
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain(ACCOUNT_VALUE);

  // 렌더러에서 값을 꺼낼 수단이 없다
  const list = await page.evaluate(() => window.qa.secrets.list());
  expect(JSON.stringify(list)).not.toContain(SECRET);

  await first.app.close();

  // 데이터 폴더 전체에 평문이 없다
  const disk = readDirRecursive(userDataDir);
  expect(disk).not.toContain(SECRET);
  expect(disk).not.toContain(ACCOUNT_VALUE);

  // 재시작 후 상태 유지, 삭제 가능
  const second = await launchApp({ userDataDir });
  await second.page.getByRole("button", { name: "설정", exact: true }).click();
  const again = second.page.getByTestId("secret-anthropicApiKey");
  await expect(again.getByTestId("secret-status")).toHaveText("저장됨");
  await again.getByRole("button", { name: "삭제" }).click();
  await expect(again.getByTestId("secret-status")).toHaveText("저장 안 됨");
  await second.app.close();
});

test("일반 설정: 잘못된 값은 거부되고, 저장한 값은 재시작 후에도 유지된다", async () => {
  const first = await launchApp();
  await first.page.getByRole("button", { name: "설정", exact: true }).click();
  const general = first.page.getByRole("form", { name: "일반" });

  // 1단계 방어: 화면의 입력 검증이 제출을 막는다
  const retention = general.getByLabel("로컬 증적 보관 일수");
  await retention.fill("999");
  await general.getByRole("button", { name: "저장" }).click();
  expect(await retention.evaluate((el) => (el as HTMLInputElement).validity.valid)).toBe(false);
  await expect(general.getByRole("status")).toHaveCount(0);

  // 2단계 방어: 화면을 우회해 IPC 로 직접 보내도 main 이 거부한다
  const bypass = await first.page.evaluate(async () => {
    try {
      await window.qa.settings.update({ evidence: { retentionDays: 999 } });
      return "accepted";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(bypass).toContain("invalid-input");
  expect((await first.page.evaluate(() => window.qa.settings.get())).settings.evidence.retentionDays).toBe(30);

  await general.getByLabel("로컬 증적 보관 일수").fill("14");
  await general.getByLabel("QA 기기 언어").fill("en_US");
  await general.getByRole("button", { name: "저장" }).click();
  await expect(general.getByRole("status")).toHaveText("저장했습니다");

  await first.page.getByLabel(/외부 GitHub 증적 업로드/).check();
  await expect(first.page.getByLabel(/외부 GitHub 증적 업로드/)).toBeChecked();
  await first.app.close();

  const second = await launchApp({ userDataDir: first.userDataDir });
  const state = await second.page.evaluate(() => window.qa.settings.get());
  expect(state.settings.evidence.retentionDays).toBe(14);
  expect(state.settings.devices.locale).toBe("en_US");
  expect(state.settings.policy.evidenceUploadApproved).toBe(true);
  expect(state.issue).toBeNull();
  await second.app.close();
});

test("LLM 사용량: 이번 달 agent_job 비용을 상한과 함께 보여 준다", async () => {
  // 처음 실행으로 DB 마이그레이션을 마친 뒤, 지난달·이번 달 작업을 직접 넣는다(실제 API 호출 없음)
  const first = await launchApp();
  await first.page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(first.page.getByTestId("agent-usage")).toContainText("$0.00 / 상한 $100.00 · 작업 0건");
  await first.app.close();

  const db = new DatabaseSync(join(first.userDataDir, "db.sqlite"));
  const insert = db.prepare("INSERT INTO agent_job (id, type, status, input, model, cost_usd, created_at) VALUES (?, ?, 'succeeded', '{}', 'claude-opus-5-5', ?, ?)");
  const now = new Date();
  insert.run("job-this-month", "author", 1.234, now.toISOString());
  insert.run("job-last-month", "judge", 50, new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString());
  db.close();

  const second = await launchApp({ userDataDir: first.userDataDir });
  await second.page.getByRole("button", { name: "설정", exact: true }).click();
  const usage = second.page.getByTestId("agent-usage");
  await expect(usage).toContainText("$1.23 / 상한 $100.00 · 작업 1건");
  await expect(usage).toContainText("플로우 만들기 1건 $1.23");

  // 상한을 낮추면 바로 다시 집계하고, 넘었으면 경고한다
  const general = second.page.getByRole("form", { name: "일반" });
  await general.getByLabel("월 LLM 비용 상한 (USD, API 키 방식)").fill("1");
  await general.getByRole("button", { name: "저장" }).click();
  await expect(usage).toContainText("상한 $1.00");
  await expect(usage.getByRole("alert")).toContainText("상한에 닿아");
  await second.app.close();
});

test("테스트 계정 값: 워크스페이스 accounts.yaml 의 앱·키 이름이 줄로 나오고 값만 넣는다. 워크스페이스에 없는 키는 따로 보인다", async () => {
  const token = "github_pat_E2EACC_0123456789abcdefghijklmnop";
  const remote = await startFakeWorkspaceRemote(token);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((t) => window.qa.secrets.set({ name: "githubToken", value: t }), token);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    // 예전에 넣었지만 지금 워크스페이스에는 없는 키
    await page.evaluate(() => window.qa.secrets.set({ name: "account:old-app:OLD_KEY", value: "old-value-1234" }));

    // 연결 전: 직접 추가만 보인다
    await page.getByRole("button", { name: "설정", exact: true }).click();
    const section = page.getByTestId("account-values");
    await expect(section).toContainText("워크스페이스를 연결하면");
    await expect(section.getByRole("form", { name: "테스트 계정 값 추가" })).toBeVisible();

    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await page.getByRole("button", { name: "설정", exact: true }).click();

    // 앱마다 accounts.yaml 의 키가 줄로 나온다(Demo 1개 + Sample 2개)
    await expect(section.getByTestId("account-values-summary")).toHaveText("아직 넣지 않은 값 3개");
    const demo = section.getByTestId("account-app-demo");
    await expect(demo).toContainText("signup 역할");
    const row = demo.getByTestId("secret-account:demo:DEMO_TEST_PASSWORD");
    await expect(row.getByTestId("secret-status")).toHaveText("저장 안 됨");
    await expect(section.getByTestId("account-app-sample").getByTestId("secret-account:sample:SAMPLE_TEST_STUDENT_ID")).toBeVisible();

    // 값만 넣으면 된다
    await row.getByLabel("demo · DEMO_TEST_PASSWORD 입력").fill("e2e-local-pw-2026");
    await row.getByRole("button", { name: "저장" }).click();
    await expect(row.getByTestId("secret-status")).toHaveText("저장됨");
    await expect(section.getByTestId("account-values-summary")).toHaveText("아직 넣지 않은 값 2개");

    // 워크스페이스에 없는 키는 따로, 직접 추가는 접혀 있다
    await expect(section.getByTestId("account-values-others")).toContainText("old-app · OLD_KEY");
    await expect(section.getByRole("form", { name: "테스트 계정 값 추가" })).toBeHidden();
    expect(await page.content()).not.toContain("e2e-local-pw-2026");
    await app.close();
  } finally {
    await remote.close();
  }
});
