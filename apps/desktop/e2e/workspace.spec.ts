import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2EWS_0123456789abcdefghijklmnopqrstu";

function allFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    const st = statSync(p, { throwIfNoEntry: false });
    return !st ? [] : st.isDirectory() ? allFiles(p) : [p];
  });
}

test("워크스페이스: 앱에서 TC 를 고쳐 저장하면 작업 브랜치에 커밋되고, PR 올리기로 PR 이 생긴다 (T-110)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page, userDataDir } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));

    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("acme/qa-workspace");
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await expect(page.getByTestId("workspace-status")).toContainText("바뀐 파일");
    // 예시 워크스페이스는 새 폴더 구조라 구조 바꾸기 안내가 없다(ADR 0032)
    await expect(page.getByTestId("layout-migration")).toHaveCount(0);

    // TC 화면에서 원문으로 고친다
    await page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await expect(page.getByTestId("tc-demo-TC-0101")).toContainText("이메일로 회원가입하면 홈 화면이 열린다");
    await expect(page.getByTestId("tc-demo-TC-0101")).toContainText("ios");
    await page.getByTestId("tc-demo-TC-0101").getByRole("button", { name: "demo/TC-0101" }).click();
    await page.getByRole("tab", { name: "원문" }).click();
    const editor = page.getByLabel("테스트 케이스 원문");
    const original = await editor.inputValue();
    await editor.fill(original.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고"));
    await page.getByLabel("변경 요약").fill("connect screen wording");
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0101-connect-screen-wording 에 커밋했습니다");

    // 형식이 틀리면 린트가 막아 저장 버튼이 꺼진다
    await editor.fill("## 스텝\n1. 아무것도");
    await expect(page.getByTestId("tc-lint")).toContainText("차단");
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();
    await editor.fill(original.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고"));

    await expect(page.getByLabel("PR 제목")).toHaveValue("TC-0101 connect screen wording");
    await page.getByRole("button", { name: "PR 올리기" }).click();
    await expect(page.getByTestId("tc-pr")).toContainText("PR #7");
    expect(remote.api.pulls).toEqual([
      expect.objectContaining({ repo: "acme/qa-workspace", head: "qa/qa-bot/TC-0101-connect-screen-wording", base: "main", title: "TC-0101 connect screen wording" }),
    ]);
    expect(remote.git(remote.bare, "log", "-1", "--format=%s", "qa/qa-bot/TC-0101-connect-screen-wording")).toBe("tc: TC-0101 connect screen wording");
    expect(remote.git(remote.bare, "log", "-1", "--format=%s", "main")).toBe("template");
    await app.close();

    const leaked = allFiles(userDataDir).filter((f) => readFileSync(f).includes(Buffer.from(TOKEN)));
    expect(leaked).toEqual([]);
    expect(readFileSync(join(userDataDir, "workspaces", "qa-workspace", ".git", "config"), "utf8")).not.toContain(TOKEN);
  } finally {
    await remote.close();
  }
});

test("폴더 구조 바꾸기: 예전 구조의 워크스페이스를 앱별 폴더로 옮겨 작업 브랜치에 커밋하고 PR 로 올린다 (ADR 0032)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN, { legacyLayout: true });
  try {
    const { app, page, userDataDir } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    // 예전 구조도 그대로 읽는다
    expect((await page.evaluate(() => window.qa.workspace.testcases())).testcases.map((t) => t.path)).toEqual(["testcases/demo/TC-0101.md", "testcases/sample/TC-0002.md"]);

    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    const card = page.getByTestId("layout-migration");
    await expect(card).toContainText("지금은 예전 폴더 구조입니다");
    await card.getByRole("button", { name: "새 폴더 구조로 바꾸기" }).click();
    await card.getByRole("button", { name: "정말 바꾸기" }).click();
    await expect(page.getByTestId("layout-migration-message")).toContainText("qa/qa-bot/workspace/layout-v2 에 커밋했습니다");
    await expect(page.getByTestId("workspace-status")).toContainText("qa/qa-bot/workspace/layout-v2");

    // 옮긴 뒤에도 같은 TC·플로우가 새 경로로 보이고 문제가 없다
    const list = await page.evaluate(() => window.qa.workspace.testcases());
    expect(list.testcases.map((t) => t.path)).toEqual(["apps/demo/testcases/TC-0101.md", "apps/sample/testcases/TC-0002.md"]);
    expect(list.testcases.find((t) => t.id === "TC-0101")?.flows).toEqual(["ios"]);
    expect(list.issues).toEqual([]);
    const ws = join(userDataDir, "workspaces", "qa-workspace");
    expect(readFileSync(join(ws, "workspace.yaml"), "utf8")).toContain("schemaVersion: 2");
    expect(statSync(join(ws, "testcases"), { throwIfNoEntry: false })).toBeUndefined();

    // main 에 직접 올리지 않고 PR 로 올린다
    const main = remote.git(remote.bare, "rev-parse", "main");
    await card.getByRole("button", { name: "PR 작성" }).click();
    await expect(page.getByTestId("layout-migration-pr")).toContainText("PR #");
    expect(remote.git(remote.bare, "rev-parse", "main")).toBe(main);
    expect(remote.git(remote.bare, "show", "qa/qa-bot/workspace/layout-v2:workspace.yaml")).toContain("schemaVersion: 2");
    expect(remote.git(remote.bare, "ls-tree", "-r", "--name-only", "qa/qa-bot/workspace/layout-v2")).toContain("apps/demo/flows/ios/TC-0101.yaml");
    await app.close();
  } finally {
    await remote.close();
  }
});

test("워크스페이스에서 실행: TC·태그를 고르면 main 이 플로우를 찾아 차례 실행에 넣는다 (PLAN 12장)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());

    await page.getByRole("button", { name: "실행", exact: true }).click();
    // 실행할 것은 탭으로 고른다. 워크스페이스가 있으면 테스트 케이스가 기본이다
    const panel = page.getByTestId("run-setup");
    await expect(panel.getByRole("tab", { name: "테스트 케이스" })).toHaveAttribute("aria-selected", "true");
    await panel.getByLabel("실행할 앱").selectOption("demo");
    await expect(panel.getByTestId("run-what-hint")).toContainText("플로우가 있는 테스트 케이스 1개");
    await panel.getByLabel("실행할 테스트 케이스").selectOption("TC-0101");
    // 실행 중인 기기가 없으면 시작할 수 없다. 실행 버튼은 하나이고 고른 방법에 따라 이름이 바뀐다
    await expect(panel.getByRole("button", { name: "테스트 케이스 실행" })).toBeDisabled();
    await panel.getByRole("tab", { name: "태그" }).click();
    await panel.getByLabel("실행할 태그").selectOption("smoke");
    await expect(panel.getByTestId("run-what-hint")).toContainText("smoke 태그가 붙은 테스트 케이스 1개를 차례로 실행합니다: TC-0101");
    await expect(panel.getByRole("button", { name: /태그로 차례 실행 \(1개\)/ })).toBeDisabled();
    await panel.getByRole("tab", { name: "플로우 파일" }).click();
    await expect(panel.getByRole("button", { name: "플로우 파일 고르기" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "플로우 실행" })).toBeDisabled();
    // 기기·빌드는 방법과 상관없이 한 번만 고른다
    await expect(panel.getByLabel("실행 기기")).toHaveCount(1);
    await expect(panel.getByLabel("실행 빌드")).toHaveCount(1);

    // 화면을 우회한 요청: 없는 플로우는 main 이 거부하고, 기기가 없으면 차례 실행에 오류로 남는다
    expect(
      await page.evaluate(() => window.qa.runs.startFromWorkspace({ app: "demo", target: "android", tcId: "TC-0101", deviceId: "x", buildId: null }).then(() => "ok", (e: unknown) => String(e))),
    ).toContain("플로우가 없다");
    expect(
      await page.evaluate(() => window.qa.runs.startFromWorkspace({ app: "demo", target: "ios", tcId: "TC-0101", tag: "smoke", deviceId: "x", buildId: null } as never).then(() => "ok", (e: unknown) => String(e))),
    ).toContain("invalid-input");
    await page.evaluate(() => window.qa.runs.startFromWorkspace({ app: "demo", target: "ios", tag: "smoke", deviceId: "no-device", buildId: null }));
    await expect.poll(async () => (await page.evaluate(() => window.qa.runs.queue())).errors.join(" ")).toContain("TC-0101");
    await app.close();
  } finally {
    await remote.close();
  }
});

test("홈: 워크스페이스 상태, 최근 실행, 내 PR 이 보인다 (PLAN 12장)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await expect(page.getByTestId("home-workspace")).toContainText("GitHub 조직");
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(async () => {
      await window.qa.workspace.connect();
      const tc = await window.qa.workspace.readTestcase({ app: "demo", id: "TC-0101" });
      await window.qa.workspace.saveTestcase({ app: "demo", id: "TC-0101", text: tc.text.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고"), summary: "home check" });
      await window.qa.workspace.requestReview({ title: "TC-0101 문구", body: "홈 화면 확인" });
    });
    await page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await page.getByRole("button", { name: "홈", exact: true }).click();
    await expect(page.getByTestId("home-workspace")).toContainText("acme/qa-workspace");
    await expect(page.getByTestId("home-workspace")).toContainText("qa/qa-bot/TC-0101-home-check");
    // 진행 중인 작업은 개수로 보이고 Git 상태 인스펙터를 연다
    await expect(page.getByTestId("home-pulls")).toContainText("열린 PR 1개");
    await page.getByTestId("home-pulls").getByRole("button", { name: "Git 상태 열기" }).click();
    await expect(page.getByTestId("git-inspector").getByTestId("git-pull-7")).toContainText("TC-0101 문구");
    await expect(page.getByTestId("home-runs")).toContainText("실행 기록이 없습니다.");
    await expect(page.getByTestId("home-trend")).toContainText("실행 기록이 쌓이면");
    await expect(page.getByTestId("home-live")).toHaveCount(0);
    await app.close();
  } finally {
    await remote.close();
  }
});
