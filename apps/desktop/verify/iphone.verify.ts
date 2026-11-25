import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, startRun, type VerifyRun } from "./harness";

// iPhone 실기기 검증(ADR 0034, 사용자가 원할 때만): 화면에서 서명 팀을 고르고, iPhone 을 점검·준비(도구 설치, 러너 서명)하고,
// iPhone 의 설정 앱으로 "플로우 파일" 재생(통과·실패)을 한 뒤 결과 화면에서 캡처를 본다. 앱 데이터는 임시 폴더다.
//   QA_VERIFY_IPHONE_ID    iPhone UDID(케이블 연결, 잠금 해제, 개발자 모드)
//   QA_VERIFY_IPHONE_TEAM  러너를 서명할 팀 ID(키체인에 Apple Development 인증서가 있어야 한다)
// iPhone 의 설정은 바꾸지 않는다. 러너 앱이 iPhone 에 설치된 채 남는다.
const ID = process.env["QA_VERIFY_IPHONE_ID"] ?? "";
const TEAM = process.env["QA_VERIFY_IPHONE_TEAM"] ?? "";

test("iPhone: 서명 팀 → 점검·준비 → 플로우 파일 재생(통과·실패) → 결과", async () => {
  test.skip(!ID || !TEAM, "QA_VERIFY_IPHONE_ID·TEAM 을 주면 돈다(실제 iPhone 에서 설정 앱을 조작한다)");
  test.setTimeout(30 * 60_000);
  const flows = mkdtempSync(join(tmpdir(), "qa-verify-iphone-flows-"));
  mkdirSync(flows, { recursive: true });
  const head = "appId: com.apple.Preferences\n";
  const steps = '---\n- launchApp\n- extendedWaitUntil:\n    visible:\n      id: "com.apple.settings.general"\n    timeout: 30000\n- tapOn:\n    id: "magnifyingglass"\n- inputText: "Avocado"\n- takeScreenshot: 01_search\n';
  writeFileSync(join(flows, "TC-9001.yaml"), `${head}name: TC-9001 설정 검색\ntags: [TC-9001]\n${steps}`);
  writeFileSync(join(flows, "TC-9002.yaml"), `${head}name: TC-9002 없는 항목\ntags: [TC-9002]\n${steps}- tapOn: "없는 항목 9002"\n`);

  const run = await startRun("iphone");
  const { page } = run;
  const nav = page.getByRole("navigation", { name: "주 메뉴" });
  try {
    run.note("doctor", await doctor(run));

    // 1. 설정 › 기기: 키체인에서 찾은 팀을 고른다
    await nav.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("navigation", { name: "설정 구역" }).getByRole("button", { name: /기기/ }).click();
    await page.getByTestId("ios-signing-team").selectOption(TEAM);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
    await run.shot("settings-team");

    // 2. 기기 › iPhone: 점검(러너 없이) → 준비(도구 설치·러너 서명)
    await nav.getByRole("button", { name: "기기", exact: true }).click();
    const prepare = page.getByRole("region", { name: "QA 기기 준비" });
    await prepare.getByRole("tab", { name: "iPhone 실기기" }).click();
    await expect(page.getByLabel("iPhone", { exact: true }).locator(`option[value="${ID}"]`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByLabel("iPhone", { exact: true }).selectOption(ID);
    await expect(page.getByTestId("iphone-checks")).toBeVisible({ timeout: 60_000 });
    await run.shot("iphone-checked");
    run.note("readiness-before", await page.evaluate((id) => window.qa.devices.checkIosDevice({ id }), ID));
    await prepare.getByRole("button", { name: "iPhone 준비" }).click();
    await expect(page.getByTestId("iphone-check-runner")).toBeVisible({ timeout: 20 * 60_000 });
    await run.shot("iphone-prepared");
    await expect(page.getByTestId("device-message")).toContainText("준비됨");
    await expect(page.getByTestId(`device-ios-${ID}`)).toContainText("연결됨");

    // 3. 실행(플로우 파일): 빌드 없이 iPhone 에 설치된 설정 앱으로
    const runs: string[] = [];
    for (const name of ["TC-9001", "TC-9002"]) {
      await nav.getByRole("button", { name: "실행", exact: true }).click();
      const setup = page.getByTestId("run-setup");
      await setup.getByRole("tab", { name: "플로우 파일" }).click();
      await stubOpenDialog(run.app, join(flows, `${name}.yaml`));
      await setup.getByRole("button", { name: "플로우 파일 고르기" }).click();
      await expect(setup.getByTestId("picked-flow")).toBeVisible();
      await setup.getByLabel("앱 ID").fill("sample");
      await setup.getByLabel("실행 기기").selectOption(ID);
      await run.shot(`run-${name}-ready`);
      await setup.getByRole("button", { name: "플로우 실행" }).click();
      // iPhone 은 시작 전에 연결·잠금·서명·앱 설치를 점검해 몇 초 걸린다
      await expect(setup.getByTestId("run-message")).toContainText("실행을 시작했습니다", { timeout: 60_000 });
      const done = await waitForLatestRun(page, runs);
      runs.push(done.id);
      run.note(`run-${name}`, done);
      run.note(`run-${name}-detail`, await page.evaluate((runId) => window.qa.runs.get({ runId }), done.id));
      await showResult(run, done.id, `result-${name}`);
    }
    const [pass, fail] = await Promise.all(runs.map((id) => page.evaluate((runId) => window.qa.runs.get({ runId }), id)));
    expect(pass?.status).toBe("passed");
    // 1회차는 없는 항목에서 실패하고 실패 화면이 남는다. 재시도(2회차)도 같은 곳에서 실패한다(iPhone 이 잠기면 잠금 해제 안내로 끝난다)
    const first = fail?.executions[0];
    expect(first?.status).toBe("failed");
    expect(first?.steps.find((s) => s.status === "failed")?.failureScreenshot).toBe("failure.png");
    expect(fail?.status === "failed" || /잠금 해제/.test(fail?.failureMessage ?? "")).toBe(true);
  } finally {
    await run.close().catch(() => undefined);
  }
});

async function waitForLatestRun(page: Page, previous: readonly string[]) {
  let latest: Awaited<ReturnType<typeof window.qa.runs.list>>[number] | undefined;
  await expect
    .poll(
      async () => {
        latest = (await page.evaluate(() => window.qa.runs.list())).find((r) => !previous.includes(r.id));
        return latest && latest.status !== "queued" && latest.status !== "running" ? latest.status : "waiting";
      },
      { timeout: 15 * 60_000, intervals: [5_000] },
    )
    .not.toBe("waiting");
  if (!latest) throw new Error("실행이 없다");
  return latest;
}

/** 결과 화면에서 그 실행을 열고 캡처가 보이는지 본다 */
async function showResult(run: VerifyRun, runId: string, label: string) {
  const { page } = run;
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "결과", exact: true }).click();
  await page.getByTestId(`results-run-${runId}`).click();
  await expect(page.getByTestId("results-detail")).toBeVisible();
  // 마지막 시도가 시작 전 점검(잠금 등)에서 끝났으면 캡처가 없다. 스텝이 있는 실행만 캡처를 본다
  const detail = await page.evaluate((id) => window.qa.runs.get({ runId: id }), runId);
  if ((detail.executions.at(-1)?.steps.length ?? 0) > 0) await expect(page.getByTestId("capture-img")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await run.shot(label);
}

async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}
