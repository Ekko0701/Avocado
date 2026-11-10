import { expect, test, type Page } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYGIT_0123456789abcdefghijkl";

// Git 상태 인스펙터: 툴바의 "Git 상태" 버튼으로 오른쪽 판을 열어 진행 중인 커밋·PR 을 종류별로 보고, 거기서 PR 을 올리고 브랜치를 바꾼다.
// 원격은 예시 워크스페이스로 만든 로컬 git 서버와 가짜 GitHub API 다(실제 GitHub 은 건드리지 않는다)
test("Git 상태 인스펙터: 빈 상태 → 커밋 → PR 작성 → 열린 PR → 체크아웃", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("git-inspector", { env: remote.env });
  try {
    await doctor(run);
    const { page } = run;
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    await expect(page.getByTestId("tc-demo-TC-0101")).toBeVisible();

    // 아무 작업도 없을 때: 배지가 없고, 열면 빈 상태가 보인다
    await expect(page.getByTestId("toolbar-git-count")).toHaveCount(0);
    await run.shot("closed-nothing");
    await page.getByTestId("toolbar-git").click();
    const git = page.getByTestId("git-inspector");
    await expect(git.getByTestId("git-empty")).toContainText("진행 중인 작업이 없습니다");
    await expect(git.getByTestId("git-summary")).toContainText("main");
    await run.shot("open-nothing");

    // 테스트 케이스 둘을 고쳐 저장한다(브랜치 둘). 인스펙터는 열린 채로 따라온다
    await saveTitle(page, "demo/TC-0101", "이메일로 가입하면 홈 화면이 열린다", "title wording");
    await page.getByRole("button", { name: "sample/TC-0002" }).click();
    await expect(page.getByRole("heading", { name: /sample\/TC-0002/ })).toBeVisible();
    await saveTitle(page, null, "학생 계정으로 로그인한다", "title wording");
    const first = git.getByTestId("git-branch-qa/qa-bot/TC-0101-title-wording");
    const second = git.getByTestId("git-branch-qa/qa-bot/TC-0002-title-wording");
    await expect(first).toContainText("커밋 1개");
    await expect(second).toContainText("지금");
    await expect(page.getByTestId("toolbar-git-count")).toHaveText("2");
    await run.shot("open-two-commits");

    // PR 작성: 지금 브랜치가 아닌 TC-0101 을 올린다
    await first.getByRole("button", { name: "PR 작성" }).click();
    const form = first.getByRole("form", { name: "PR 작성" });
    await form.getByLabel("PR 제목").fill("TC-0101 제목 다듬기");
    await run.shot("pr-form");
    await form.getByRole("button", { name: "PR 올리기" }).click();
    await expect(git.getByTestId("git-pr")).toContainText("PR #7 을 만들었습니다");
    await expect(git.getByTestId("git-pull-7")).toContainText("TC-0101 제목 다듬기");
    await expect(git.getByTestId("git-commits").getByRole("listitem")).toHaveCount(1);
    await run.shot("open-commit-and-pr");
    expect(remote.api.pulls).toEqual([expect.objectContaining({ head: "qa/qa-bot/TC-0101-title-wording", base: "main", title: "TC-0101 제목 다듬기" })]);

    // 체크아웃: PR 을 올린 브랜치로 옮기면 요약과 목록이 그 브랜치로 바뀐다
    await git.getByTestId("git-pull-7").getByRole("button", { name: "체크아웃" }).click();
    await expect(git.getByTestId("git-message")).toContainText("qa/qa-bot/TC-0101-title-wording 로 체크아웃했습니다");
    await expect(git.getByTestId("git-summary")).toContainText("qa/qa-bot/TC-0101-title-wording");
    await expect(page.getByTestId("tc-demo-TC-0101")).toContainText("이메일로 가입하면 홈 화면이 열린다");
    await run.shot("checked-out");
    await git.getByRole("button", { name: "main 으로 돌아가기" }).click();
    await expect(git.getByTestId("git-message")).toContainText("main 로 체크아웃했습니다");
    await expect(git.getByTestId("git-summary")).toContainText("원격 main 과 같습니다");
    // main 에서는 두 브랜치 모두 "지금"이 아니고 체크아웃할 수 있다
    await expect(git.getByTestId("git-pull-7").getByRole("button", { name: "체크아웃" })).toBeVisible();
    await expect(second.getByRole("button", { name: "체크아웃" })).toBeVisible();
    await expect(page.getByTestId("tc-demo-TC-0101")).toContainText("이메일로 회원가입하면 홈 화면이 열린다");

    // 다크 모드, 다른 화면, 닫기
    await run.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await run.shot("dark-open");
    await page.getByRole("button", { name: "홈", exact: true }).click();
    await expect(git).toBeVisible();
    await run.shot("dark-home-open");
    await page.emulateMedia({ colorScheme: "light" });
    await run.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await page.getByTestId("toolbar-git").click();
    await expect(page.getByTestId("git-inspector")).toHaveCount(0);
    await run.shot("closed-with-badge");

    run.note("remote", { pulls: remote.api.pulls, branches: await page.evaluate(() => window.qa.workspace.branches()) });
  } finally {
    await run.close();
    await remote.close();
  }
});

/** 연 테스트 케이스(없으면 이름으로 연다)의 제목을 고쳐 저장한다 */
async function saveTitle(page: Page, open: string | null, title: string, summary: string) {
  if (open) {
    await page.getByRole("button", { name: open }).click();
    await expect(page.getByTestId("tc-form")).toBeVisible();
  }
  await page.getByTestId("tc-form").getByLabel("제목").fill(title);
  await page.getByLabel("변경 요약").fill(summary);
  await page.getByRole("button", { name: "저장(커밋)" }).click();
  await expect(page.getByTestId("tc-message")).toContainText("에 커밋했습니다");
  await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeVisible();
}
