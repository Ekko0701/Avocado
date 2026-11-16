import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

// 워크스페이스 내보내기·가져오기(T-127, ADR 0036 결정 11) 실제 확인: 새 앱 데이터 A 의 로컬 워크스페이스에 iOS 설정 앱(com.apple.Preferences)을
// 화면에서 등록하고 테스트 케이스를 쓰고 플로우 파일을 넣은 뒤 zip 으로 내보낸다. 새 앱 데이터 B 에서 그 zip 을 가져와(실제 Maestro 문법 검사)
// 시뮬레이터에서 테스트 케이스로 실행해 결과 화면에서 통과를 본다. 플로우 만들기는 사용자의 Claude 앱이 있어야 해서 플로우 파일은 이 여정이 쓴다.
//   QA_VERIFY_TOOLS  앱 관리 Maestro·JRE 가 든 tools 폴더(기본 out/e2e/real-run-userdata/tools). 새 앱 데이터마다 복제한다
// 실제 시뮬레이터를 켠다. 이 실행이 켠 시뮬레이터만 마지막에 끈다. 파일 선택 창만 바꿔 끼우고, GitHub 요청은 가짜 서버로 세어 0건임을 본다
const TOOLS = process.env["QA_VERIFY_TOOLS"] || join(__dirname, "../../../out/e2e/real-run-userdata/tools");
const TOKEN = "github_pat_VERIFYTRANSFERREAL_0123456789abc";
const APP = "settings";
const FLOW = [
  "appId: ${APP_ID}",
  "name: TC-0001 설정 첫 화면",
  "tags: [TC-0001]",
  "---",
  "- launchApp",
  "- extendedWaitUntil:",
  "    visible:",
  '      id: "com.apple.settings.general"',
  "    timeout: 30000",
  "- takeScreenshot: 01_settings_home",
  "",
].join("\n");

function freshUserData(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // APFS 복제(cp -c)라 용량을 더 쓰지 않는다
  execFileSync("/bin/cp", ["-cR", TOOLS, join(dir, "tools")]);
  return dir;
}

function stubDialogs(app: ElectronApplication, paths: { open?: string; save?: string }) {
  return app.evaluate(({ dialog }, p) => {
    if (p.open) (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p.open] });
    if (p.save) (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p.save });
  }, paths);
}

test("내보내기·가져오기: A 에서 설정 앱 테스트 케이스를 내보내고 B 에서 가져와 시뮬레이터에서 실행 통과", async () => {
  test.setTimeout(40 * 60_000);
  if (!existsSync(TOOLS)) throw new Error(`tools 폴더가 없다: ${TOOLS}`);
  const bootedBefore = bootedSimulators();
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const work = mkdtempSync(join(tmpdir(), "qa-verify-transfer-real-"));
  const zip = join(work, "settings-workspace.zip");
  try {
    // A: 화면으로 앱 등록·테스트 케이스, 플로우 파일, 내보내기
    const a = await startRun("transfer-real-export", { userDataDir: freshUserData("qa-verify-transfer-a-"), workspaceSource: "local", env: remote.env });
    try {
      a.note("doctor", await doctor(a));
      const nav = a.page.getByRole("navigation", { name: "주 메뉴" });
      await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
      const first = a.page.getByRole("form", { name: "첫 앱 등록" });
      await first.getByLabel("앱 id", { exact: true }).fill(APP);
      await first.getByLabel("앱 이름").fill("설정");
      await first.getByLabel("iOS 앱 ID", { exact: true }).fill("com.apple.Preferences");
      await first.getByRole("button", { name: "앱 등록" }).click();
      await expect(a.page.getByTestId(`ws-nav-${APP}`)).toBeVisible();

      await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
      await a.page.getByRole("button", { name: "새 테스트 케이스" }).click();
      const editor = a.page.getByTestId("tc-editor");
      await editor.getByTestId("tc-form").getByLabel("제목").fill("설정 앱을 열면 첫 화면이 보인다");
      await editor.getByTestId("tc-form").getByRole("combobox", { name: "상태" }).selectOption("active");
      await editor.getByRole("button", { name: "저장", exact: true }).click();
      await expect(a.page.getByTestId("tc-message")).toHaveText(/^저장했습니다/);

      const localDir = join(a.userDataDir, "local-workspace");
      mkdirSync(join(localDir, "apps", APP, "flows", "ios"), { recursive: true });
      writeFileSync(join(localDir, "apps", APP, "flows", "ios", "TC-0001.yaml"), FLOW);
      const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=verify", "-c", "user.email=verify@avocado.local", ...args], { cwd: localDir }).toString().trim();
      git("add", "--", "apps");
      git("commit", "--quiet", "-m", "flow: TC-0001 verify flow");

      await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
      await a.page.getByTestId("ws-nav-transfer").click();
      const panel = a.page.getByTestId("transfer");
      await expect(panel.getByTestId("export-includes")).toContainText("TC-0001");
      await a.shot("export");
      await stubDialogs(a.app, { save: zip });
      await panel.getByRole("button", { name: "zip 으로 저장…" }).click();
      await expect(panel.getByTestId("export-saved")).toBeVisible();
      await a.shot("export-saved");
      a.note("export-zip", execFileSync("/usr/bin/unzip", ["-Z1", zip]).toString().trim().split("\n"));
      a.note("source-log", git("log", "--format=%h %s"));
    } finally {
      await a.close().catch(() => undefined);
    }

    // B: 가져오기 → 시뮬레이터에서 테스트 케이스 실행 → 결과 통과
    const b = await startRun("transfer-real-import", { userDataDir: freshUserData("qa-verify-transfer-b-"), workspaceSource: "local", env: remote.env });
    try {
      b.note("doctor", await doctor(b));
      const { page } = b;
      const nav = page.getByRole("navigation", { name: "주 메뉴" });
      await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
      await page.getByTestId("ws-nav-transfer").click();
      const panel = page.getByTestId("transfer");
      await panel.getByRole("tab", { name: "가져오기" }).click();
      await stubDialogs(b.app, { open: zip });
      await panel.getByRole("button", { name: "zip 고르기…" }).click();
      const preview = panel.getByTestId("import-preview");
      await expect(preview).toContainText("settings-workspace.zip", { timeout: 5 * 60_000 });
      await expect(preview.getByTestId("import-row-testcase:settings:TC-0001")).toContainText("새로 생김");
      await b.shot("import-preview");
      b.note("preview-rows", await preview.locator("tbody tr[data-testid]").allInnerTexts());
      await panel.getByRole("button", { name: /^고른 항목 \d+개 가져오기$/ }).click();
      await expect(panel.getByTestId("import-done")).toContainText("로컬 워크스페이스에 가져왔습니다");
      await b.shot("import-done");
      b.note("imported-log", execFileSync("/usr/bin/git", ["log", "--format=%h %s", "--stat"], { cwd: join(b.userDataDir, "local-workspace") }).toString());

      const device = await page.evaluate(() => window.qa.devices.prepareIos({}));
      b.note("device", device);
      await nav.getByRole("button", { name: "실행", exact: true }).click();
      const setup = page.getByTestId("run-setup");
      await setup.getByRole("tab", { name: "테스트 케이스" }).click();
      await setup.getByLabel("실행할 앱").selectOption(APP);
      await setup.getByLabel("실행 타깃").selectOption("ios");
      await setup.getByLabel("실행할 테스트 케이스").selectOption("TC-0001");
      await setup.getByLabel("실행 기기").selectOption(device.id);
      await b.shot("runs-ready");
      await setup.getByRole("button", { name: "테스트 케이스 실행" }).click();
      let finished = await waitForRun(page, 1);
      b.note("run-1", finished);
      // 막 켠 시뮬레이터에서 1회차가 오류로 끝난 적이 있다(T-125 기록). 그때만 한 번 더 돌리고 둘 다 남긴다
      if (finished.status === "error") {
        await setup.getByRole("button", { name: "테스트 케이스 실행" }).click();
        finished = await waitForRun(page, 2);
        b.note("run-2", finished);
      }
      await b.shot("runs-done");
      expect(finished).toMatchObject({ status: "passed", tcId: "TC-0001", target: "ios" });

      await nav.getByRole("button", { name: "결과", exact: true }).click();
      await page.getByTestId(`results-run-${finished.id}`).click();
      await expect(page.getByTestId("results-detail")).toBeVisible();
      await expect(page.getByTestId("capture-img")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await b.shot("results");
      b.note("github-requests", { api: remote.api.requests.length, git: remote.gitServer.seen });
      expect(remote.api.requests).toEqual([]);
      expect(remote.gitServer.seen).toEqual({ authorized: 0, rejected: 0 });
    } finally {
      await b.close().catch(() => undefined);
    }
  } finally {
    await remote.close();
    rmSync(work, { recursive: true, force: true });
    // 이 실행이 켠 시뮬레이터만 끈다
    for (const udid of bootedSimulators().filter((u) => !bootedBefore.includes(u))) execFileSync("/usr/bin/xcrun", ["simctl", "shutdown", udid]);
  }
});

function bootedSimulators(): string[] {
  const out = JSON.parse(execFileSync("/usr/bin/xcrun", ["simctl", "list", "devices", "booted", "--json"]).toString()) as { devices: Record<string, { udid: string; state: string }[]> };
  return Object.values(out.devices)
    .flat()
    .filter((d) => d.state === "Booted")
    .map((d) => d.udid);
}

/** 실행 기록이 count 개가 되고 맨 위(가장 최근) 것이 끝날 때까지 기다린다 */
async function waitForRun(page: Page, count: number) {
  let latest: Awaited<ReturnType<typeof window.qa.runs.list>>[number] | undefined;
  await expect
    .poll(
      async () => {
        const runs = await page.evaluate(() => window.qa.runs.list());
        latest = runs[0];
        return runs.length >= count && latest && latest.status !== "queued" && latest.status !== "running" ? latest.status : "waiting";
      },
      { timeout: 15 * 60_000, intervals: [5_000] },
    )
    .not.toBe("waiting");
  if (!latest) throw new Error("실행이 없다");
  return latest;
}
