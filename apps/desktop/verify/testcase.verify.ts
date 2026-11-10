import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTestcase } from "../../../packages/workspace/src/model";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYTC_0123456789abcdefghijklmn";

// 기획자처럼 새 테스트 케이스를 템플릿으로 쓰고 저장(커밋)한 뒤 PR 을 올린다.
// 원격은 예시 워크스페이스로 만든 로컬 git 서버와 가짜 GitHub API 다(실제 GitHub 은 건드리지 않는다)
test("테스트 케이스 작성: 템플릿 → 린트 → 저장(커밋) → 다시 열기 → PR", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("testcase", { env: remote.env });
  try {
    await doctor(run);
    const { page } = run;
    // 준비: 토큰·조직(실제 사용자는 설정 화면에서 넣는다)
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await run.shot("workspace-connected");

    await page.getByRole("button", { name: "테스트 케이스", exact: true }).click();
    // 2단: 왼쪽 목록, 오른쪽은 고르기 전 안내
    await expect(page.getByTestId("tc-demo-TC-0101")).toBeVisible();
    await expect(page.getByTestId("tc-empty")).toContainText("테스트 케이스를 고르세요");
    await run.shot("list-idle");
    await page.getByLabel("새 테스트 케이스 앱").selectOption("demo");
    await page.getByRole("button", { name: "새 테스트 케이스" }).click();
    await expect(page.getByRole("heading", { name: /demo\/TC-0102/ })).toBeVisible();
    const form = page.getByTestId("tc-form");
    await form.getByLabel("제목").fill("닉네임이 짧으면 가입할 수 없다");
    await form.getByLabel("태그(쉼표로 구분)").fill("auth, validation");
    await form.getByLabel("전제조건(한 줄에 하나)").fill("로그인하지 않은 상태로 앱을 연다");
    const step1 = page.getByTestId("tc-step-0");
    await step1.getByLabel("1. 동작").fill("'이메일로 계속하기'를 탭한다");
    await step1.getByLabel("기대(한 줄에 하나)").fill("회원가입 화면이 열린다");
    const step2 = page.getByTestId("tc-step-1");
    await step2.getByLabel("2. 동작").fill("닉네임에 '가'를 입력하고 '가입하기'를 탭한다");
    // 기대를 비우면 린트가 막는다
    await step2.getByLabel("기대(한 줄에 하나)").fill("");
    await expect(page.getByTestId("tc-lint")).toContainText('스텝 2 에 "기대"가 없다');
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();
    await run.shot("lint-blocks-save");
    await step2.getByLabel("기대(한 줄에 하나)").fill("'닉네임 (2~12자)' 오류가 보이고 가입되지 않는다");
    await form.getByLabel("완료 기준(한 줄에 하나)").fill("짧은 닉네임으로는 홈 화면으로 넘어가지 않는다");
    await expect(page.getByTestId("tc-lint")).toContainText("린트 문제 없음");
    await run.shot("filled");

    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0102-add-tc-0102 에 커밋했습니다");
    // 메시지가 먼저 뜨고 목록을 다시 읽는 동안 버튼이 "저장 중"이다. 끝난 상태를 찍는다
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeVisible();
    await run.shot("saved");

    // 두 번째 화면: 다른 테스트 케이스를 열었다가 목록에서 다시 열어 저장된 값을 본다
    await page.getByRole("button", { name: "demo/TC-0101" }).click();
    await expect(page.getByRole("heading", { name: /demo\/TC-0101/ })).toBeVisible();
    await page.getByRole("button", { name: "demo/TC-0102" }).click();
    await expect(page.getByTestId("tc-form").getByLabel("제목")).toHaveValue("닉네임이 짧으면 가입할 수 없다");
    await run.shot("reopened");

    await page.getByLabel("PR 제목").fill("TC-0102 닉네임 길이 검증");
    await page.getByRole("button", { name: "PR 올리기" }).click();
    await expect(page.getByTestId("tc-pr")).toContainText("PR #7");
    await expect(page.getByRole("button", { name: "PR 올리기" })).toBeVisible();
    await run.shot("pr-created");

    // 목록은 따로 스크롤하고 저장 줄은 편집 칸 아래에 붙어 있다: 편집 칸을 끝까지 내려도 목록과 저장 버튼이 보인다
    await page.getByTestId("tc-pr").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("tc-demo-TC-0101")).toBeInViewport();
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeInViewport();
    expect(await page.locator("main").evaluate((main) => main.scrollTop)).toBe(0);
    // 본문이 좁아지면(Git 상태 인스펙터를 열면) 목록 아래에 편집을 두고 화면 전체를 스크롤한다
    await page.getByTestId("toolbar-git").click();
    await expect(page.getByTestId("git-inspector").getByTestId("git-summary")).toBeVisible();
    const listBox = await page.getByRole("region", { name: "테스트 케이스 목록" }).boundingBox();
    const editorBox = await page.getByTestId("tc-editor").boundingBox();
    if (!listBox || !editorBox) throw new Error("목록 또는 편집 칸이 화면에 없다");
    expect(editorBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
    expect(editorBox.x).toBe(listBox.x);
    await run.shot("narrow-with-inspector");
    // 편집 칸이 화면 아래로 이어지고 화면 전체가 스크롤된다
    await page.getByRole("button", { name: "저장(커밋)" }).scrollIntoViewIfNeeded();
    expect(await page.locator("main").evaluate((main) => main.scrollTop)).toBeGreaterThan(0);
    await run.shot("narrow-scrolled");
    await page.getByTestId("toolbar-git").click();

    // 화면 밖의 결과: 원격 브랜치에 올라간 파일과 PR 요청
    const branch = "qa/qa-bot/TC-0102-add-tc-0102";
    const pushed = remote.git(remote.bare, "show", `${branch}:apps/demo/testcases/TC-0102.md`);
    writeFileSync(join(run.dir, "pushed-TC-0102.md"), pushed);
    const parsed = parseTestcase(pushed);
    expect(parsed.ok && parsed.doc.frontMatter).toMatchObject({ id: "TC-0102", app: "demo", title: "닉네임이 짧으면 가입할 수 없다", tags: ["auth", "validation"] });
    expect(remote.api.pulls).toEqual([expect.objectContaining({ head: branch, base: "main", title: "TC-0102 닉네임 길이 검증" })]);
    run.note("remote", { branchLog: remote.git(remote.bare, "log", "--format=%s", `main..${branch}`), pulls: remote.api.pulls });
  } finally {
    await run.close();
    await remote.close();
  }
});
