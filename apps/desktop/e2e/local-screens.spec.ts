import { expect, test } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFakeToolArchives, fakeToolDefinitions, serveFiles, type FakeArchives, type FileServer } from "../test-support/fake-tools";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

// 로컬 워크스페이스 화면(T-125, ADR 0036): GitHub 사용을 끈 사람은 마법사부터 테스트 케이스 저장까지 브랜치·PR·동기화·Git 상태를 보지 않는다.
// 도구는 로컬 서버의 가짜 묶음을 쓴다. 환경 점검(Xcode 등)은 이 Mac 의 실제 상태를 본다.

const TOKEN = "github_pat_E2ESCREENS_0123456789abcdefghijklmn";
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

test("GitHub 사용을 끄면 마법사 → 첫 앱 → 테스트 케이스 저장 → 설정까지 Git 요소 없이 되고 GitHub 에 닿지 않는다 (T-125)", async () => {
  test.setTimeout(240_000);
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page, userDataDir } = await launchApp({ setupCompleted: false, toolsFile, env: remote.env, workspaceSource: "local" });

    const steps = page.getByRole("list", { name: "마법사 단계" });
    await expect(steps).toContainText("저장 위치");
    await expect(steps).toContainText("첫 앱");
    await expect(steps).not.toContainText("GitHub");
    await page.getByRole("region", { name: "Claude 연결 단계" }).getByRole("button", { name: "다음" }).click();

    const storage = page.getByRole("region", { name: "저장 위치 단계" });
    await expect(storage.getByLabel("GitHub 사용")).not.toBeChecked();
    await expect(storage.getByLabel("GitHub 토큰 입력")).toHaveCount(0);
    await expect(storage.getByTestId("wizard-local-places")).toContainText("local-workspace");
    await expect(storage.getByTestId("wizard-local-places")).toContainText("30일 보관");
    // 켜면 토큰 칸이 나오고 4단계가 GitHub·워크스페이스가 된다. 끄면 돌아간다
    await storage.getByLabel("GitHub 사용").check();
    await expect(storage.getByLabel("GitHub 토큰 입력")).toBeVisible();
    await expect(steps).toContainText("GitHub·워크스페이스");
    expect(await page.evaluate(() => window.qa.workspace.status().then((s) => s.source))).toBe("github");
    await storage.getByLabel("GitHub 사용").uncheck();
    await expect(storage.getByLabel("GitHub 토큰 입력")).toHaveCount(0);
    await expect(steps).toContainText("첫 앱");
    expect(await page.evaluate(() => window.qa.workspace.status().then((s) => s.source))).toBe("local");
    await storage.getByRole("button", { name: "다음" }).click();

    const env = page.getByRole("region", { name: "환경 점검 단계" });
    await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("필요", { timeout: 60_000 });
    await env.getByRole("button", { name: "필요한 도구 모두 설치" }).click();
    await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("정상", { timeout: 60_000 });
    await env.getByRole("button", { name: "다음" }).click();

    const first = page.getByRole("region", { name: "첫 앱 단계" });
    await expect(first.getByRole("heading", { name: "4. 첫 앱" })).toBeVisible();
    await expect(first.getByRole("button", { name: "건너뛰기" })).toBeEnabled();
    await first.getByLabel("앱 id", { exact: true }).fill("notes");
    await first.getByLabel("앱 이름").fill("Notes");
    await expect(first.getByRole("button", { name: "앱 등록하고 다음" })).toBeDisabled();
    await first.getByLabel("iOS 앱 ID", { exact: true }).fill("com.example.notes");
    await expect(first.getByTestId("first-app-subflows")).toContainText("common/launch-clean.yaml");
    await expect(first.getByTestId("first-app-subflows")).toContainText("시뮬레이터용입니다");
    await first.getByRole("button", { name: "앱 등록하고 다음" }).click();
    await page.getByRole("region", { name: "QA 기기 단계" }).getByRole("button", { name: "건너뛰기" }).click();
    const finish = page.getByRole("region", { name: "완료 단계" });
    await expect(finish.getByText("필수 환경이 모두 준비됐습니다.")).toBeVisible({ timeout: 60_000 });
    await expect(finish).not.toContainText("GitHub 토큰");
    await finish.getByRole("button", { name: "마법사 완료" }).click();
    await expect(page.getByRole("heading", { name: "홈" })).toBeVisible();

    // 툴바: 로컬 워크스페이스 표시만 있고 동기화·브랜치·Git 상태가 없다
    const toolbar = page.getByRole("banner", { name: "툴바" });
    await expect(toolbar.getByTestId("toolbar-workspace")).toContainText("로컬 워크스페이스");
    await expect(toolbar.getByTestId("toolbar-workspace")).toContainText("이 Mac · 혼자 쓰기");
    await expect(toolbar.getByRole("button", { name: "워크스페이스 동기화" })).toHaveCount(0);
    await expect(toolbar.getByTestId("toolbar-git")).toHaveCount(0);

    // 홈: 워크스페이스 줄은 이 Mac 의 로컬 워크스페이스와 앱 수. 진행 중인 작업·작업 브랜치가 없다
    await expect(page.getByTestId("home-workspace")).toContainText("이 Mac 의 로컬 워크스페이스 · 앱 1개");
    await expect(page.getByTestId("home-pulls")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("브랜치");

    // 워크스페이스: 출처와 폴더, 첫 앱, 저장 버튼은 "저장"
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("로컬 워크스페이스");
    await expect(page.getByTestId("workspace-status")).toContainText(join(userDataDir, "local-workspace"));
    await expect(page.getByRole("region", { name: "워크스페이스 상태" }).getByRole("button", { name: "Finder 에서 열기" })).toBeVisible();
    await expect(page.getByTestId("ws-nav-notes")).toBeVisible();
    await expect(page.getByTestId("app-settings").getByRole("button", { name: "저장", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("PR");
    await expect(page.locator("main")).not.toContainText("브랜치");

    // 테스트 케이스: 쓰고 저장하면 저장했다고만 알린다. 브랜치·PR 이 없다
    await page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await page.getByRole("button", { name: "새 테스트 케이스" }).click();
    const editor = page.getByTestId("tc-editor");
    await editor.getByTestId("tc-form").getByLabel("제목").fill("설정 화면이 열린다");
    await expect(editor.getByTestId("tc-lint")).toHaveText("린트 문제 없음 · 저장하면 바로 실행할 수 있습니다");
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByTestId("tc-message")).toHaveText(/^저장했습니다\([0-9a-f]{7,}\)$/);
    await expect(page.getByTestId("tc-notes-TC-0001")).toContainText("설정 화면이 열린다");
    await expect(page.getByRole("region", { name: "테스트 케이스 목록" })).toContainText("테스트 케이스 1개 · 이 Mac 의 로컬 워크스페이스");
    await expect(page.getByTestId("tc-history")).toHaveCount(1);
    await expect(page.locator("main")).not.toContainText("브랜치");
    await expect(page.getByRole("form", { name: "PR 작성" })).toHaveCount(0);

    // 실행: 로컬은 늘 연결돼 있어 연결 안내가 없다
    await page.getByRole("button", { name: "실행", exact: true }).click();
    await expect(page.getByLabel("실행할 앱")).toHaveValue("notes");
    await expect(page.locator("main")).not.toContainText("워크스페이스를 연결하면");

    // 설정: GitHub 구역은 쓰지 않음. 켜려다 취소하면 그대로 로컬이다
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("settings-nav-github")).toContainText("쓰지 않음 · 로컬 워크스페이스");
    await expect(page.getByTestId("settings-nav-evidence")).not.toContainText("업로드");
    const github = page.getByRole("region", { name: "GitHub" });
    await expect(github.getByLabel("GitHub 토큰 입력")).toHaveCount(0);
    await expect(github.getByLabel("GitHub 조직")).toHaveCount(0);
    await expect(github.getByTestId("github-local-location")).toContainText(join(userDataDir, "local-workspace"));
    const use = github.getByLabel("GitHub 사용");
    await expect(use).not.toBeChecked();
    await use.check();
    const confirm = github.getByRole("alertdialog", { name: "GitHub 사용을 켭니다" });
    await expect(confirm).toContainText("로컬 워크스페이스에 만든 테스트 케이스 1개와 플로우 0개는 옮겨지지 않고 이 Mac 에 그대로 남습니다");
    await confirm.getByRole("button", { name: "취소" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(use).not.toBeChecked();
    expect(await page.evaluate(() => window.qa.workspace.status().then((s) => s.source))).toBe("local");
    expect(JSON.parse(readFileSync(join(userDataDir, "settings.json"), "utf8"))).toMatchObject({ workspace: { source: "local" } });
    await expect(toolbar.getByTestId("toolbar-workspace")).toContainText("로컬 워크스페이스");
    await app.close();

    // 이 여정 동안 가짜 GitHub API 와 git HTTP 서버가 받은 요청이 0건이다
    expect(remote.api.requests).toEqual([]);
    expect(remote.gitServer.seen).toEqual({ authorized: 0, rejected: 0 });
  } finally {
    await remote.close();
  }
});
