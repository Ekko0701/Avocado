import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun, type VerifyRun } from "./harness";

// Android 에뮬레이터 실기기 검증(사용자가 원할 때만): 실제 AVD 를 화면에서 준비하고, 실제 .apk 를 등록·설치하고, 실제 Maestro 로 플로우를 재생해 결과·증적을 본다.
// 테스트 대상 앱은 환경 변수로 받는다(이 파일에는 특정 앱 이름을 쓰지 않는다).
//   QA_VERIFY_ANDROID_APK    등록할 .apk
//   QA_VERIFY_ANDROID_APP    워크스페이스 앱 id(예: demo)
//   QA_VERIFY_ANDROID_FLOW   "플로우 파일"로 재생할 .yaml(같은 폴더에 common/ 이 있어야 한다)
//   QA_VERIFY_ANDROID_AVD    준비할 AVD(기본 qa_pixel_7_api35)
//   QA_VERIFY_ANDROID_WORKSPACE, QA_VERIFY_ANDROID_TC   (선택) 그 앱이 든 워크스페이스 폴더와 TC id. 주면 가짜 원격으로 연결해 "테스트 케이스"로도 재생한다
//   QA_VERIFY_TOOLS          앱 관리 Maestro·JRE 가 든 tools 폴더(기본 out/e2e/real-run-userdata/tools). 새 앱 데이터에 복사한다
// 이 실행이 켠 에뮬레이터만 마지막에 끈다. 앱 데이터는 임시 폴더다(사용자의 Avocado 데이터·GitHub 은 건드리지 않는다)
const env = (name: string) => process.env[name] ?? "";
const APK = env("QA_VERIFY_ANDROID_APK");
const APP = env("QA_VERIFY_ANDROID_APP");
const FLOW = env("QA_VERIFY_ANDROID_FLOW");
const AVD = env("QA_VERIFY_ANDROID_AVD") || "qa_pixel_7_api35";
const WORKSPACE = env("QA_VERIFY_ANDROID_WORKSPACE");
const TC = env("QA_VERIFY_ANDROID_TC");
const TOOLS = env("QA_VERIFY_TOOLS") || join(__dirname, "../../../out/e2e/real-run-userdata/tools");
const TOKEN = "github_pat_VERIFYAND_0123456789abcdefghijkl";
const ADB = join(env("ANDROID_HOME") || join(homedir(), "Library", "Android", "sdk"), "platform-tools", "adb");

test("Android 에뮬레이터: 기기 준비 → 빌드 등록·설치 → 플로우 재생 → 결과·증적", async () => {
  test.skip(!APK || !APP || !FLOW, "QA_VERIFY_ANDROID_APK·APP·FLOW 를 주면 돈다(실제 에뮬레이터를 켠다)");
  test.setTimeout(30 * 60_000);
  const runningBefore = emulatorSerials();
  const remote = WORKSPACE && TC ? await startFakeWorkspaceRemote(TOKEN, { seed: WORKSPACE }) : null;
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-android-"));
  if (!existsSync(TOOLS)) throw new Error(`tools 폴더가 없다: ${TOOLS}`);
  // APFS 복제(cp -c)라 용량을 더 쓰지 않는다
  execFileSync("/bin/cp", ["-cR", TOOLS, join(userDataDir, "tools")]);
  const run = await startRun("android-emulator", { userDataDir, env: remote?.env ?? {} });
  const { page } = run;
  const nav = page.getByRole("navigation", { name: "주 메뉴" });
  try {
    run.note("doctor", await doctor(run));
    // 복사한 Maestro·JRE 를 앱이 설치된 것으로 본다
    const tools = (await page.evaluate(() => window.qa.setup.check())).tools;
    run.note("tools", tools);
    expect(tools.every((t) => t.installed)).toBe(true);

    // 1. 기기: AVD 를 화면에서 준비한다(화면 없이 부팅, 언어·애니메이션 설정)
    await nav.getByRole("button", { name: "기기", exact: true }).click();
    await page.getByLabel("AVD").selectOption(AVD);
    await run.shot("devices-before");
    await page.getByRole("button", { name: "Android 에뮬레이터 준비" }).click();
    // 준비가 끝나면(부팅·언어 적용·애니메이션 끄기) 기기 이름과 언어가 메시지로 뜬다. 실패하면 "Android 준비 실패: …"
    await expect(page.getByTestId("device-message")).toBeVisible({ timeout: 8 * 60_000 });
    await expect(page.getByTestId("device-message")).toHaveText(`${AVD}: 실행 중 · 언어 ko-KR`);
    const device = await page.evaluate((avd) => window.qa.devices.list().then((l) => l.devices.find((d) => d.platform === "android" && d.id === avd) ?? null), AVD);
    run.note("device", device);
    expect(device).toMatchObject({ state: "booted", kind: "emulator" });
    await run.shot("devices-ready");

    // 2. 빌드: .apk 를 파일로 등록하고 그 에뮬레이터에 설치한다
    await nav.getByRole("button", { name: "빌드", exact: true }).click();
    await page.getByLabel("앱 ID").fill(APP);
    await stubOpenDialog(run.app, APK);
    await page.getByRole("button", { name: "파일로 등록" }).click();
    await expect(page.getByTestId("build-message")).toContainText("등록했습니다", { timeout: 120_000 });
    const [build] = await page.evaluate(() => window.qa.builds.list());
    if (!build) throw new Error("빌드가 등록되지 않았다");
    run.note("build", build);
    expect(build).toMatchObject({ app: APP, target: "android" });
    const row = page.getByTestId(`build-${build.id}`);
    await row.getByLabel("설치할 기기").selectOption(AVD);
    await row.getByRole("button", { name: "설치", exact: true }).click();
    await expect(page.getByTestId("build-message")).toContainText("설치했습니다", { timeout: 5 * 60_000 });
    await run.shot("build-installed");

    // 3. 실행(플로우 파일): 고른 .yaml 을 그 빌드·에뮬레이터로 재생한다
    await nav.getByRole("button", { name: "실행", exact: true }).click();
    const setup = page.getByTestId("run-setup");
    await setup.getByRole("tab", { name: "플로우 파일" }).click();
    await stubOpenDialog(run.app, FLOW);
    await setup.getByRole("button", { name: "플로우 파일 고르기" }).click();
    await expect(setup.getByTestId("picked-flow")).toBeVisible();
    await setup.getByLabel("실행 빌드").selectOption(build.id);
    await setup.getByLabel("실행 기기").selectOption(AVD);
    await run.shot("run-file-ready");
    await setup.getByRole("button", { name: "플로우 실행" }).click();
    await expect(setup.getByTestId("run-message")).toContainText("실행을 시작했습니다");
    const fileRun = await waitForLatestRun(page, null);
    run.note("run-file", fileRun);
    await run.shot("run-file-done");
    await showResult(run, fileRun.id, "result-file");
    expect(fileRun.status).toBe("passed");

    // 4. 실행(테스트 케이스): 워크스페이스의 TC 를 고르면 main 이 그 플로우를 찾아 재생한다
    if (remote) {
      await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
      await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
      await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
      await page.getByRole("button", { name: "연결(clone)" }).click();
      await expect(page.getByTestId("workspace-status")).toContainText("main");
      await nav.getByRole("button", { name: "실행", exact: true }).click();
      await setup.getByRole("tab", { name: "테스트 케이스" }).click();
      await setup.getByLabel("실행할 앱").selectOption(APP);
      await setup.getByLabel("실행 타깃").selectOption("android");
      await setup.getByLabel("실행할 테스트 케이스").selectOption(TC);
      await setup.getByLabel("실행 기기").selectOption(AVD);
      await setup.getByLabel("실행 빌드").selectOption(build.id);
      await run.shot("run-tc-ready");
      await setup.getByRole("button", { name: "테스트 케이스 실행" }).click();
      const tcRun = await waitForLatestRun(page, fileRun.id);
      run.note("run-tc", tcRun);
      await run.shot("run-tc-done");
      await showResult(run, tcRun.id, "result-tc");
      expect(tcRun).toMatchObject({ status: "passed", tcId: TC, target: "android" });
      await nav.getByRole("button", { name: "결과", exact: true }).click();
      await expect(page.getByTestId(`tc-cell-${TC}-android`)).toHaveText("통과");
      await run.shot("results-matrix");
    }
  } finally {
    await run.close().catch(() => undefined);
    await remote?.close();
    // 이 실행이 켠 에뮬레이터만 끈다
    for (const serial of emulatorSerials().filter((s) => !runningBefore.includes(s))) execFileSync(ADB, ["-s", serial, "emu", "kill"]);
  }
});

function emulatorSerials(): string[] {
  if (!existsSync(ADB)) return [];
  return execFileSync(ADB, ["devices"])
    .toString()
    .split("\n")
    .map((l) => l.split("\t")[0] ?? "")
    .filter((s) => s.startsWith("emulator-"));
}

/** 가장 최근 실행이 끝날 때까지 기다린다(previous 가 아닌 새 실행) */
async function waitForLatestRun(page: Page, previous: string | null) {
  let latest: Awaited<ReturnType<typeof window.qa.runs.list>>[number] | undefined;
  await expect
    .poll(
      async () => {
        latest = (await page.evaluate(() => window.qa.runs.list())).find((r) => r.id !== previous);
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
  await expect(page.getByTestId("capture-img")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await run.shot(label);
  run.note(label, await page.evaluate((id) => window.qa.runs.get({ runId: id }), runId));
}

/** 파일 선택 창은 자동화할 수 없어 main 의 대화상자를 바꾼다(e2e/builds.spec.ts 와 같다) */
async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}
