import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

// 로컬 워크스페이스 화면(T-125, ADR 0036) 실제 확인: GitHub 사용을 끈 새 앱 데이터로 마법사부터 시작해
// iOS 설정 앱(com.apple.Preferences)을 화면에서 등록하고, 테스트 케이스를 화면에서 쓰고, 플로우 파일을 로컬 워크스페이스에 넣은 뒤
// 실행 화면에서 테스트 케이스로 시뮬레이터에 재생해 결과 화면에서 통과를 본다. 화면마다 스크린샷을 남긴다.
// 플로우 만들기는 사용자의 Claude 앱이 있어야 해서 플로우 파일은 이 여정이 쓴다(ADR 0036 T-125 실제 확인).
//   QA_VERIFY_TOOLS  앱 관리 Maestro·JRE 가 든 tools 폴더(기본 out/e2e/real-run-userdata/tools). 새 앱 데이터에 복제한다
// 실제 시뮬레이터를 켠다. 이 실행이 켠 시뮬레이터만 마지막에 끈다. GitHub 요청은 가짜 서버로 세어 0건임을 본다
const TOOLS = process.env["QA_VERIFY_TOOLS"] || join(__dirname, "../../../out/e2e/real-run-userdata/tools");
const TOKEN = "github_pat_VERIFYLOCAL_0123456789abcdefghijk";
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

test("로컬 워크스페이스: 마법사 → 설정 앱 등록 → 테스트 케이스 → 시뮬레이터에서 테스트 케이스 실행 → 결과 통과", async () => {
  test.setTimeout(30 * 60_000);
  if (!existsSync(TOOLS)) throw new Error(`tools 폴더가 없다: ${TOOLS}`);
  const bootedBefore = bootedSimulators();
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-local-"));
  // APFS 복제(cp -c)라 용량을 더 쓰지 않는다
  execFileSync("/bin/cp", ["-cR", TOOLS, join(userDataDir, "tools")]);
  const run = await startRun("local-workspace", { userDataDir, setupCompleted: false, workspaceSource: "local", env: remote.env });
  const { page } = run;
  const nav = page.getByRole("navigation", { name: "주 메뉴" });
  const localDir = join(userDataDir, "local-workspace");
  try {
    run.note("doctor", await doctor(run));
    await expect(page.getByRole("heading", { name: "설정 마법사" })).toBeVisible();
    run.note("status-start", await page.evaluate(() => window.qa.workspace.status()));

    // 빈 로컬 워크스페이스: 출처·폴더와 첫 앱 등록 양식
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await expect(page.getByRole("form", { name: "첫 앱 등록" })).toBeVisible();
    await expect(page.getByTestId("workspace-status")).toContainText("로컬 워크스페이스");
    await run.shot("workspace-empty");

    // 마법사: 저장 위치(GitHub 사용 꺼짐) → 환경 → 첫 앱 → QA 기기 → 완료
    await nav.getByRole("button", { name: "설정 마법사", exact: true }).click();
    await page.getByRole("region", { name: "Claude 연결 단계" }).getByRole("button", { name: "다음" }).click();
    const storage = page.getByRole("region", { name: "저장 위치 단계" });
    await expect(storage.getByLabel("GitHub 사용")).not.toBeChecked();
    await expect(storage.getByTestId("wizard-local-places")).toContainText("local-workspace");
    await run.shot("wizard-storage");
    await storage.getByRole("button", { name: "다음" }).click();
    const env = page.getByRole("region", { name: "환경 점검 단계" });
    await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("정상", { timeout: 120_000 });
    await env.getByRole("button", { name: "다음" }).click();
    const first = page.getByRole("region", { name: "첫 앱 단계" });
    await first.getByLabel("앱 이름").fill("설정");
    // 한글 이름은 앱 id 를 만들지 못해 칸이 열린다
    await first.getByLabel("앱 id", { exact: true }).fill(APP);
    await first.getByLabel("iOS 앱 ID", { exact: true }).fill("com.apple.Preferences");
    await expect(first.getByTestId("first-app-subflows")).toContainText("common/launch-clean.yaml");
    await run.shot("wizard-first-app");
    await first.getByRole("button", { name: "앱 등록하고 다음" }).click();
    const deviceStep = page.getByRole("region", { name: "QA 기기 단계" });
    await deviceStep.getByRole("button", { name: "iOS 시뮬레이터 준비" }).click();
    await expect(deviceStep.getByTestId("wizard-device")).toContainText("booted", { timeout: 8 * 60_000 });
    await run.shot("wizard-device");
    await deviceStep.getByRole("button", { name: "다음" }).click();
    const finish = page.getByRole("region", { name: "완료 단계" });
    await expect(finish.getByText("필수 환경이 모두 준비됐습니다.")).toBeVisible({ timeout: 120_000 });
    await finish.getByRole("button", { name: "마법사 완료" }).click();
    await expect(page.getByRole("heading", { name: "홈" })).toBeVisible();

    // 홈과 툴바: 로컬 워크스페이스 표시, 동기화·Git 상태·작업 브랜치 없음
    const toolbar = page.getByRole("banner", { name: "툴바" });
    await expect(toolbar.getByTestId("toolbar-workspace")).toContainText("로컬 워크스페이스");
    await expect(toolbar.getByTestId("toolbar-git")).toHaveCount(0);
    await expect(page.getByTestId("home-workspace")).toContainText("이 Mac 의 로컬 워크스페이스 · 앱 1개");
    await expect(page.getByTestId("app-version")).toBeVisible();
    await run.shot("home");

    // 워크스페이스: 등록한 앱과 공통 서브플로우
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await expect(page.getByTestId(`ws-nav-${APP}`)).toBeVisible();
    await expect(page.getByTestId("app-settings").getByLabel("iOS 앱 ID", { exact: true })).toHaveValue("com.apple.Preferences");
    await run.shot("workspace");

    // 테스트 케이스: 화면에서 쓰고 저장한다
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await page.getByRole("button", { name: "새 테스트 케이스" }).click();
    const editor = page.getByTestId("tc-editor");
    await editor.getByTestId("tc-form").getByLabel("제목").fill("설정 앱을 열면 첫 화면이 보인다");
    await editor.getByTestId("tc-form").getByRole("combobox", { name: "상태" }).selectOption("active");
    await expect(editor.getByTestId("tc-lint")).toHaveText("린트 문제 없음 · 저장하면 바로 실행할 수 있습니다");
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByTestId("tc-message")).toHaveText(/^저장했습니다/);
    await run.shot("testcases-saved");

    // 플로우: 플로우 만들기 대신 로컬 워크스페이스에 파일로 넣고 커밋한다
    const flowDir = join(localDir, "apps", APP, "flows", "ios");
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, "TC-0001.yaml"), FLOW);
    const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=verify", "-c", "user.email=verify@avocado.local", ...args], { cwd: localDir }).toString().trim();
    git("add", "--", "apps");
    git("commit", "--quiet", "-m", "flow: TC-0001 verify flow");
    run.note("local-log", git("log", "--format=%h %s"));

    // 플로우 만들기 화면: 로컬 문구(진행 중인 작업이 없을 때의 안내)
    await nav.getByRole("button", { name: "플로우 만들기", exact: true }).click();
    await page.getByRole("combobox", { name: "테스트 케이스" }).selectOption(`${APP}/TC-0001`);
    await expect(page.getByTestId("author-flow-note")).toContainText("로컬 워크스페이스");
    await run.shot("author");

    // 테스트 케이스 목록에 플로우가 보인다
    await nav.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await expect(page.getByTestId(`tc-${APP}-TC-0001`)).toContainText("플로우 ios");
    await page.getByTestId(`tc-${APP}-TC-0001`).getByRole("button").click();
    await expect(page.getByTestId("tc-history")).toHaveCount(1);
    await run.shot("testcases");

    // 실행: 테스트 케이스로 시뮬레이터에서 재생한다
    const device = await page.evaluate(() => window.qa.devices.list().then((l) => l.devices.find((d) => d.platform === "ios" && d.state === "booted" && d.kind === "simulator") ?? null));
    if (!device) throw new Error("켜진 QA 시뮬레이터가 없다");
    run.note("device", device);
    await nav.getByRole("button", { name: "실행", exact: true }).click();
    const setup = page.getByTestId("run-setup");
    await setup.getByRole("tab", { name: "테스트 케이스" }).click();
    await setup.getByLabel("실행할 앱").selectOption(APP);
    await setup.getByLabel("실행 타깃").selectOption("ios");
    await setup.getByLabel("실행할 테스트 케이스").selectOption("TC-0001");
    await setup.getByLabel("실행 기기").selectOption(device.id);
    await run.shot("runs-ready");
    await setup.getByRole("button", { name: "테스트 케이스 실행" }).click();
    const finished = await waitForRun(page);
    run.note("run", finished);
    await run.shot("runs-done");
    expect(finished).toMatchObject({ status: "passed", tcId: "TC-0001", target: "ios" });

    // 결과: 통과와 캡처. 증적 올리기 탭이 없다
    await nav.getByRole("button", { name: "결과", exact: true }).click();
    await page.getByTestId(`results-run-${finished.id}`).click();
    await expect(page.getByTestId("results-detail")).toBeVisible();
    await expect(page.getByTestId("capture-img")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "증적 올리기" })).toHaveCount(0);
    await page.waitForTimeout(500);
    await run.shot("results");

    // 설정: GitHub 구역(쓰지 않음)과 켜기 확인. 취소하면 그대로 로컬이다
    await nav.getByRole("button", { name: "설정", exact: true }).click();
    const github = page.getByRole("region", { name: "GitHub" });
    await expect(page.getByTestId("settings-nav-github")).toContainText("쓰지 않음 · 로컬 워크스페이스");
    await run.shot("settings-github");
    await github.getByLabel("GitHub 사용").check();
    await expect(github.getByRole("alertdialog", { name: "GitHub 사용을 켭니다" })).toContainText("테스트 케이스 1개와 플로우 1개");
    await run.shot("settings-github-confirm");
    await github.getByRole("button", { name: "취소" }).click();
    await expect(github.getByLabel("GitHub 사용")).not.toBeChecked();
    run.note("status-end", await page.evaluate(() => window.qa.workspace.status()));

    run.note("github-requests", { api: remote.api.requests.length, git: remote.gitServer.seen });
    expect(remote.api.requests).toEqual([]);
    expect(remote.gitServer.seen).toEqual({ authorized: 0, rejected: 0 });
  } finally {
    await run.close().catch(() => undefined);
    await remote.close();
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

/** 이 실행의 하나뿐인 실행 기록이 끝날 때까지 기다린다 */
async function waitForRun(page: Page) {
  let latest: Awaited<ReturnType<typeof window.qa.runs.list>>[number] | undefined;
  await expect
    .poll(
      async () => {
        [latest] = await page.evaluate(() => window.qa.runs.list());
        return latest && latest.status !== "queued" && latest.status !== "running" ? latest.status : "waiting";
      },
      { timeout: 15 * 60_000, intervals: [5_000] },
    )
    .not.toBe("waiting");
  if (!latest) throw new Error("실행이 없다");
  return latest;
}
