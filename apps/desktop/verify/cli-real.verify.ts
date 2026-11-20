import { expect, test } from "@playwright/test";
import type { RunBatch } from "@qa/shared";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, startRun } from "./harness";
import { FAKE_ID, REPO, TOOLS, bootedSims, seedSettingsWorkspace } from "./settings-workspace";

// T-121 실제 확인(ADR 0035): 개발 실행한 앱에 `pnpm avocado qa run` 을 하위 프로세스로 돌려 시뮬레이터 실행의 종료 코드 0 과 1 을 보고,
// 앱을 끈 뒤 종료 코드 3 을 본다. CLI 는 QA_USER_DATA_DIR 로 이 실행의 앱 소켓을 찾는다. QA 시뮬레이터를 켜고, 이 실행이 켠 것만 끈다

function avocado(args: string[], userDataDir: string): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["-s", "avocado", ...args], { cwd: REPO, env: { ...process.env, QA_USER_DATA_DIR: userDataDir } });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}

test("avocado CLI 실제 확인: 개발 앱에 붙어 시뮬레이터 실행의 종료 코드 0·1, 앱이 꺼지면 3", async () => {
  test.setTimeout(30 * 60_000);
  if (!existsSync(TOOLS)) throw new Error(`tools 폴더가 없다: ${TOOLS}`);
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-cli-"));
  execFileSync("/bin/cp", ["-cR", TOOLS, join(userDataDir, "tools")]);
  seedSettingsWorkspace(userDataDir);
  const before = bootedSims();
  const run = await startRun("cli-real", { userDataDir, workspaceSource: "local" });
  const { page } = run;
  let simId: string | null = null;
  let closed = false;
  try {
    run.note("doctor", await doctor(run));
    await page.evaluate((v) => window.qa.secrets.set({ name: "account:settings:QA_FIXTURE_ACCOUNT_ID", value: v }), FAKE_ID);
    const sim = await page.evaluate(() => window.qa.devices.prepareIos({}));
    simId = sim.id;
    run.note("device", sim);
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "실행", exact: true }).click();

    const options = await avocado(["qa", "options"], userDataDir);
    run.note("options", options);
    expect(options.code).toBe(0);
    expect(options.out).toContain("settings-TC-0001  ios  active");

    const pass = avocado(["qa", "run", "settings-TC-0001", "--device", sim.id], userDataDir);
    // 앱의 차례 실행이 CLI 묶음이 되면 실행 화면을 다시 열어 본다(가려진 창은 화면의 주기 갱신이 늦어진다. 자동 갱신은 E2E run-batch 가 본다)
    await expect.poll(() => page.evaluate(() => window.qa.runs.queue().then((q) => q.origin)), { timeout: 120_000 }).toBe("avocado-cli 0.1.0");
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "홈", exact: true }).click();
    await nav.getByRole("button", { name: "실행", exact: true }).click();
    await expect(page.getByTestId("run-queue")).toContainText("터미널에서 시작(avocado-cli 0.1.0)", { timeout: 30_000 });
    await run.shot("cli-running");
    const passed = await pass;
    run.note("run TC-0001", passed);
    expect(passed.code).toBe(0);
    expect(passed.out).toContain("TC-0001  통과");
    expect(passed.err.match(/TC-0001 실행 중/g)).toHaveLength(1);
    const passedRun = /실행 ([0-9a-f-]{36})/.exec(passed.out)?.[1] ?? "";

    const failed = await avocado(["qa", "run", "settings/TC-0002", "--device", sim.id, "--json"], userDataDir);
    run.note("run TC-0002", failed);
    expect(failed.code).toBe(1);
    const batch = JSON.parse(failed.out) as RunBatch;
    run.note("batch TC-0002", batch);
    expect(batch.items[0]).toMatchObject({ tcId: "TC-0002", status: "failed" });
    expect(failed.out).not.toContain(FAKE_ID);
    // 결과 화면을 열면 두 실행이 있다(가려진 창은 화면의 주기 갱신이 늦어질 수 있어 화면을 다시 연다)
    await nav.getByRole("button", { name: "결과", exact: true }).click();
    for (const id of [passedRun, batch.items[0]?.runId ?? ""]) await expect(page.getByTestId(`results-run-${id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`results-run-${batch.items[0]?.runId ?? ""}`).click();
    await expect(page.getByTestId("results-detail")).toContainText("실패");
    await run.shot("cli-done-results");

    await run.close();
    closed = true;
    const off = await avocado(["qa", "options"], userDataDir);
    run.note("app closed", off);
    expect(off.code).toBe(3);
    expect(off.err).toContain("Avocado 앱에 연결하지 못했다");
  } finally {
    if (!closed) await run.close();
    if (simId && !before.includes(simId)) execFileSync("/usr/bin/xcrun", ["simctl", "shutdown", simId]);
  }
});
