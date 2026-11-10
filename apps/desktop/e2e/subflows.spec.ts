import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFakeToolArchives, fakeToolDefinitions, serveFiles, type FakeArchives, type FileServer } from "../test-support/fake-tools";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

// 저장 전 Maestro 문법 검사(check-syntax)는 앱이 설치한 Maestro 로 한다. 가짜 JRE·Maestro 를 받아 설치해 둔다
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

const TOKEN = "github_pat_E2ESUBFLOW_0123456789abcdefghijklmnop";

test("공통 서브플로우: 워크스페이스 화면에서 common/launch-clean.yaml 을 고쳐 앱 설정 브랜치에 커밋하고 PR 을 만든다", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env, toolsFile });
    await page.evaluate(async () => {
      await window.qa.setup.installTool({ tool: "jre" });
      await window.qa.setup.installTool({ tool: "maestro" });
    });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "워크스페이스", exact: true }).click();

    // 왼쪽 목록에서 앱을 고르고 공통 서브플로우 탭을 연다. 탭에 파일 수가 붙는다
    // 이미 골라진 앱을 다시 눌러도 탭의 파일 수가 남아 있다
    await expect(page.getByRole("tab", { name: "공통 서브플로우 1" })).toBeVisible();
    await page.getByTestId("ws-nav-demo").click();
    await page.getByRole("tab", { name: /^공통 서브플로우/ }).click();
    await expect(page.getByRole("tab", { name: "공통 서브플로우 1" })).toHaveAttribute("aria-selected", "true");
    const panel = page.getByTestId("subflows");
    await expect(panel.getByTestId("subflow-file-ios-launch-clean.yaml")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("subflow-used-by")).toHaveText("이 서브플로우를 부르는 플로우: TC-0101");

    // 자주 쓰는 Maestro 명령은 편집기 옆(창이 좁으면 아래)에 늘 있고, 공식 문서 링크가 있다.
    // 파일·편집기·명령 칸은 스크롤하지 않는 칸이면 내용이 칸 밖으로 넘치지 않는다(넘치면 아래 칸 위에 겹쳐 그려진다)
    const spill = await panel.evaluate((form) =>
      [".ws-files", ".ws-editor", ".ws-ref"].map((sel) => {
        const el = form.querySelector<HTMLElement>(sel);
        return el === null ? "없음" : getComputedStyle(el).overflowY === "visible" && el.scrollHeight > el.clientHeight + 1 ? `${sel} 넘침 ${el.scrollHeight}>${el.clientHeight}` : "";
      }),
    );
    expect(spill).toEqual(["", "", ""]);
    const help = page.getByTestId("maestro-help");
    await expect(help.getByText("visible 과 notVisible 중 하나는 꼭 있어야 한다", { exact: false })).toBeVisible();
    await expect(help.getByRole("button", { name: "모든 명령과 옵션 (Maestro 공식 문서)" })).toBeVisible();
    await expect(help.getByRole("button", { name: "요소 고르는 법 (선택자)" })).toBeVisible();

    const editor = panel.getByLabel("서브플로우 내용");
    const original = await editor.inputValue();
    expect(original).toContain("clearKeychain");
    await expect(panel.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();

    // 규약에 어긋나면 커밋하지 않고 이유를 보여 준다
    await editor.fill(`${original}- runScript: steal.js\n`);
    await panel.getByLabel("서브플로우 변경 요약").fill("longer wait");
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("서브플로우 규약 오류");
    await expect(page.getByTestId("subflow-message")).toContainText("runScript 는 쓰지 않는다");
    await panel.getByRole("button", { name: "되돌리기" }).click();
    await expect(editor).toHaveValue(original);

    // 조건 없는 extendedWaitUntil 은 Maestro 가 실행할 때 내는 문법 오류라 규약 검사가 막는다
    await editor.fill(original.replace(/visible: "[^"]+"\n\s+/, ""));
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("extendedWaitUntil 에는 visible 이나 notVisible 이 있어야 한다");

    // 없는 명령은 앱이 설치한 Maestro 의 check-syntax 가 막는다
    await editor.fill(`${original}- tapOnn: "닫기"\n`);
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("Maestro 문법 오류: Invalid Command: tapOnn (3행 9열)");
    await panel.getByRole("button", { name: "되돌리기" }).click();

    // 대기 시간을 늘려 저장하면 그 앱의 앱 설정 작업 브랜치에 커밋한다
    const edited = original.replace("timeout: 15000", "timeout: 30000");
    expect(edited).not.toBe(original);
    await editor.fill(edited);
    await panel.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("subflow-message")).toContainText("qa/qa-bot/app/demo/longer-wait 에 커밋했습니다");
    await expect(editor).toHaveValue(edited);
    await expect(panel).toContainText("진행 중인 앱 설정 브랜치 qa/qa-bot/app/demo/longer-wait 에서 읽었습니다");

    // PR 작성: 브랜치를 올리고 PR 을 만든다
    await panel.getByRole("button", { name: "PR 작성" }).click();
    await expect(page.getByTestId("subflow-pr")).toContainText("을 만들었습니다(qa/qa-bot/app/demo/longer-wait)");
    expect(remote.api.pulls).toEqual([
      expect.objectContaining({ head: "qa/qa-bot/app/demo/longer-wait", base: "main", title: "subflow: demo ios/common/launch-clean.yaml longer wait" }),
    ]);
    expect(remote.git(remote.bare, "show", "qa/qa-bot/app/demo/longer-wait:apps/demo/flows/ios/common/launch-clean.yaml")).toContain("timeout: 30000");
    expect(remote.git(remote.bare, "show", "--name-only", "--format=%s", "qa/qa-bot/app/demo/longer-wait").split("\n").filter(Boolean)).toEqual([
      "subflow: demo/ios launch-clean.yaml longer wait",
      "apps/demo/flows/ios/common/launch-clean.yaml",
    ]);
    await app.close();
  } finally {
    await remote.close();
  }
});
