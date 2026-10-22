import { expect, test, type Page } from "@playwright/test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFakeToolArchives,
  fakeToolDefinitions,
  FAKE_MAESTRO_VERSION,
  serveFiles,
  type FakeArchives,
  type FileServer,
} from "../test-support/fake-tools";
import { launchApp } from "./launch";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";

// 첫 실행 → 마법사 → 도구 설치 → Maestro 실행 확인 → 완료까지.
// 도구는 로컬 서버의 가짜 묶음을 쓴다(실제 내려받기는 setup.real.spec.ts).
// 환경 점검(Xcode·iOS 런타임 등)은 이 Mac 의 실제 상태를 본다.

let archives: FakeArchives;
let server: FileServer;
let toolsFile: string;

test.beforeAll(async () => {
  archives = buildFakeToolArchives();
  server = await serveFiles({ "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro });
  toolsFile = join(archives.dir, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(fakeToolDefinitions(server.url, archives)));
});

test.afterAll(async () => {
  await server.close();
  rmSync(archives.dir, { recursive: true, force: true });
});

async function skipKeySteps(page: Page) {
  await page.getByRole("region", { name: "Claude 연결 단계" }).getByRole("button", { name: "다음" }).click();
  await page.getByRole("region", { name: "GitHub 토큰 단계" }).getByRole("button", { name: "건너뛰기" }).click();
}

test("첫 실행에는 마법사가 뜨고, 도구 설치와 Maestro 확인 후 완료하면 다음부터 홈이 뜬다", async () => {
  test.setTimeout(180_000);
  const { app, page, userDataDir } = await launchApp({ setupCompleted: false, toolsFile });
  await expect(page.getByRole("heading", { name: "설정 마법사" })).toBeVisible();
  await skipKeySteps(page);

  const env = page.getByRole("region", { name: "환경 점검 단계" });
  await expect(env.getByTestId("check-xcode").getByTestId("check-status")).toHaveText("정상", { timeout: 60_000 });
  await expect(env.getByTestId("check-tool-jre").getByTestId("check-status")).toHaveText("필요");
  await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("필요");
  await expect(env.getByRole("button", { name: "Maestro 실행 확인" })).toBeDisabled();

  await env.getByRole("button", { name: "필요한 도구 모두 설치" }).click();
  await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("정상", { timeout: 60_000 });
  await expect(env.getByTestId("check-tool-jre").getByTestId("check-status")).toHaveText("정상");

  await env.getByRole("button", { name: "Maestro 실행 확인" }).click();
  await expect(env.getByTestId("maestro-verify")).toHaveText(`Maestro ${FAKE_MAESTRO_VERSION} 실행됨`);

  await env.getByRole("button", { name: "다음" }).click();
  // GitHub·워크스페이스, QA 기기는 건너뛸 수 있다(토큰이 없으면 저장소 목록을 불러올 수 없다)
  const wsStep = page.getByRole("region", { name: "워크스페이스 단계" });
  await expect(wsStep.getByRole("button", { name: "저장소 목록 불러오기" })).toBeDisabled();
  await wsStep.getByRole("button", { name: "건너뛰기" }).click();
  await page.getByRole("region", { name: "QA 기기 단계" }).getByRole("button", { name: "건너뛰기" }).click();
  const finish = page.getByRole("region", { name: "완료 단계" });
  await expect(finish.getByText("필수 환경이 모두 준비됐습니다.")).toBeVisible({ timeout: 60_000 });
  await finish.getByRole("button", { name: "마법사 완료" }).click();
  await expect(page.getByRole("heading", { name: "홈" })).toBeVisible();

  expect(existsSync(join(userDataDir, "tools", `maestro-${FAKE_MAESTRO_VERSION}`, "maestro", "bin", "maestro"))).toBe(true);
  await app.close();

  const again = await launchApp({ userDataDir, toolsFile });
  await expect(again.page.getByRole("heading", { name: "홈" })).toBeVisible();
  await again.app.close();
});

test("필수 점검이 끝나지 않으면 마법사를 완료할 수 없다", async () => {
  const { app, page } = await launchApp({ setupCompleted: false, toolsFile });
  const result = await page.evaluate(async () => {
    try {
      await window.qa.setup.complete();
      return "completed";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(result).toContain("필수 점검이 끝나지 않았다");
  await app.close();
});

test("마법사의 GitHub·워크스페이스 단계: 토큰으로 볼 수 있는 저장소에서 고르고 연결을 확인한 뒤 워크스페이스를 받는다 (PLAN 11장)", async () => {
  const token = "github_pat_E2EWIZ_0123456789abcdefghijklmnopqr";
  const remote = await startFakeWorkspaceRemote(token);
  try {
    const { app, page } = await launchApp({ setupCompleted: false, toolsFile, env: remote.env });
    await page.getByRole("region", { name: "Claude 연결 단계" }).getByRole("button", { name: "다음" }).click();
    // 사용자처럼 마법사의 토큰 단계에서 저장한다(IPC 로 바로 넣으면 마법사가 이미 읽은 목록과 어긋난다)
    const tokenStep = page.getByRole("region", { name: "GitHub 토큰 단계" });
    await tokenStep.getByLabel("GitHub 토큰 입력").fill(token);
    await tokenStep.getByRole("button", { name: "저장" }).click();
    await expect(tokenStep.getByTestId("secret-status")).toHaveText("저장됨");
    await tokenStep.getByRole("button", { name: "다음" }).click();
    await page.getByRole("region", { name: "환경 점검 단계" }).getByRole("button", { name: "다음" }).click();

    const wsStep = page.getByRole("region", { name: "워크스페이스 단계" });
    await wsStep.getByRole("button", { name: "저장소 목록 불러오기" }).click();
    await wsStep.getByLabel("워크스페이스(TC·플로우)").selectOption("acme/qa-workspace");
    await wsStep.getByLabel("증적(연도별)").selectOption(`qa-evidence-${new Date().getFullYear()}`);
    await wsStep.getByRole("button", { name: "고른 저장소로 저장" }).click();
    await expect(wsStep.getByTestId("wizard-github-verify")).toContainText("로그인: qa-bot");
    await expect(wsStep.getByTestId("wizard-github-verify")).toContainText(`acme/qa-evidence-${new Date().getFullYear()}: 읽기·쓰기`);
    await expect(wsStep.getByTestId("wizard-github-verify")).toContainText("acme/qa-workspace: 읽기·쓰기");
    await wsStep.getByRole("button", { name: "워크스페이스 연결(clone)" }).click();
    await expect(wsStep.getByTestId("wizard-workspace")).toContainText("acme/qa-workspace · main");
    await wsStep.getByRole("button", { name: "다음" }).click();
    await expect(page.getByRole("region", { name: "QA 기기 단계" })).toBeVisible();
    await app.close();
  } finally {
    await remote.close();
  }
});

test("마법사 첫 단계는 Claude 연결: 기본은 내 Claude 앱이고, API 키는 API 키 방식을 고를 때만 묻는다 (D17)", async () => {
  const { app, page } = await launchApp({ setupCompleted: false, toolsFile });
  await expect(page.getByRole("list", { name: "마법사 단계" })).toContainText("1. Claude 연결");
  await expect(page.getByRole("list", { name: "마법사 단계" })).not.toContainText("Anthropic API 키");
  const step = page.getByRole("region", { name: "Claude 연결 단계" });
  await expect(step.getByRole("radio", { name: /내 Claude 앱/ })).toBeChecked();
  await expect(step.getByTestId("claude-listening")).toContainText("Claude 연결을 기다리는 중");
  await expect(step.getByTestId("claude-code-command")).toContainText("claude mcp add-json --scope user avocado");
  await expect(step.getByLabel("Anthropic API 키 입력")).toHaveCount(0);

  // API 키 방식을 고르면 그때 키 입력이 나오고, 설정에도 저장된다
  await step.getByRole("radio", { name: /Anthropic API 키/ }).check();
  await expect(step.getByLabel("Anthropic API 키 입력")).toBeVisible();
  expect(await page.evaluate(() => window.qa.settings.get().then((s) => s.settings.agent.provider))).toBe("api");
  await step.getByRole("radio", { name: /내 Claude 앱/ }).check();
  await expect(step.getByLabel("Anthropic API 키 입력")).toHaveCount(0);
  await step.getByRole("button", { name: "다음" }).click();
  await expect(page.getByRole("region", { name: "GitHub 토큰 단계" })).toBeVisible();
  await app.close();
});
