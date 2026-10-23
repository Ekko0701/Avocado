import { expect, test } from "@playwright/test";
import { parseTestcase } from "../../../packages/workspace/src/model";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2ETC_0123456789abcdefghijklmnopqrstu";

test("TC 작성: 기획자가 템플릿으로 새 TC 를 쓰고, 린트를 통과시켜 저장하고, PR 을 만든다 (T-111)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");

    await page.getByRole("button", { name: "TC", exact: true }).click();
    // 필터: 태그 smoke 는 두 앱 모두, 앱 Demo 는 하나
    await page.getByLabel("태그 필터").selectOption("smoke");
    await expect(page.locator("tr[data-testid^='tc-']")).toHaveCount(2);
    await page.getByLabel("앱 필터").selectOption("demo");
    await expect(page.locator("tr[data-testid^='tc-']")).toHaveCount(1);

    // 템플릿으로 새 TC(다음 번호: TC-0102)
    await page.getByLabel("새 TC 앱").selectOption("demo");
    await page.getByRole("button", { name: "새 TC(템플릿)" }).click();
    const form = page.getByTestId("tc-form");
    await expect(page.getByRole("heading", { name: /demo\/TC-0102/ })).toBeVisible();
    await expect(page.getByTestId("tc-lint")).toContainText("린트 문제 없음");
    await form.getByLabel("제목").fill("닉네임이 짧으면 가입할 수 없다");
    await form.getByLabel("태그(쉼표로 구분)").fill("auth, validation");
    await form.getByLabel("전제조건(한 줄에 하나)").fill("로컬 dev 서버가 실행 중이다\n로그인하지 않은 상태로 앱을 연다");
    const step1 = page.getByTestId("tc-step-0");
    await step1.getByLabel("1. 동작").fill("'이메일로 계속하기'를 탭한다");
    await step1.getByLabel("기대(한 줄에 하나)").fill("회원가입 화면이 열린다");
    const step2 = page.getByTestId("tc-step-1");
    await step2.getByLabel("2. 동작").fill("닉네임에 '가'를 입력하고 '가입하기'를 탭한다");
    // 기대를 비우면 차단되고 저장할 수 없다
    await step2.getByLabel("기대(한 줄에 하나)").fill("");
    await expect(page.getByTestId("tc-lint")).toContainText('스텝 2 에 "기대"가 없다');
    await expect(step2).toHaveClass(/bad/);
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();
    await step2.getByLabel("기대(한 줄에 하나)").fill("'닉네임 (2~12자)' 오류가 보이고 가입되지 않는다");
    await page.getByTestId("tc-form").getByLabel("완료 기준(한 줄에 하나)").fill("짧은 닉네임으로는 홈 화면으로 넘어가지 않는다");
    await expect(page.getByTestId("tc-lint")).toContainText("린트 문제 없음");
    // 경고는 저장을 막지 않는다: 모호한 동사
    await step1.getByLabel("1. 동작").fill("화면을 확인한다");
    await expect(page.getByTestId("tc-lint")).toContainText("모호하다");
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeEnabled();
    await step1.getByLabel("1. 동작").fill("'이메일로 계속하기'를 탭한다");

    await expect(page.getByLabel("변경 요약")).toHaveValue("add TC-0102");
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0102-add-tc-0102 에 커밋했습니다");
    await expect(page.getByTestId("tc-history")).toContainText("tc: TC-0102 add TC-0102");

    await page.getByLabel("PR 제목").fill("TC-0102 닉네임 길이 검증");
    await page.getByRole("button", { name: "PR 올리기" }).click();
    await expect(page.getByTestId("tc-pr")).toContainText("PR #7");
    expect(remote.api.pulls).toEqual([expect.objectContaining({ head: "qa/qa-bot/TC-0102-add-tc-0102", base: "main", title: "TC-0102 닉네임 길이 검증" })]);

    // 원격 브랜치의 파일은 올바른 TC 다
    const pushed = remote.git(remote.bare, "show", "qa/qa-bot/TC-0102-add-tc-0102:testcases/demo/TC-0102.md");
    const parsed = parseTestcase(pushed);
    expect(parsed.ok && parsed.doc.frontMatter).toMatchObject({ id: "TC-0102", app: "demo", title: "닉네임이 짧으면 가입할 수 없다", tags: ["auth", "validation"], status: "draft", account: "signup" });
    expect(parsed.ok && parsed.doc.steps.map((s) => s.expected.length)).toEqual([1, 1]);

    // TC-0102 의 작업 브랜치에 있는 채로 TC-0101 을 고쳐 저장하면 TC-0101 의 브랜치를 main 에서 따로 만든다(섞지 않는다)
    await page.getByLabel("태그 필터").selectOption("");
    await expect(page.getByTestId("tc-demo-TC-0102")).toBeVisible();
    await page.getByRole("button", { name: "demo/TC-0101" }).click();
    await expect(page.getByRole("heading", { name: /demo\/TC-0101/ })).toBeVisible();
    await page.getByTestId("tc-form").getByLabel("제목").fill("이메일로 가입하면 홈 화면이 열린다");
    await page.getByLabel("변경 요약").fill("title wording");
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0101-title-wording 에 커밋했습니다");
    const branches = page.getByTestId("work-branches");
    await expect(branches.getByTestId("branch-qa/qa-bot/TC-0101-title-wording")).toContainText("지금");
    await expect(branches.getByTestId("branch-qa/qa-bot/TC-0102-add-tc-0102")).toContainText("tc: TC-0102 add TC-0102");
    // 지금 브랜치(TC-0101)의 목록에는 아직 머지되지 않은 TC-0102 가 없다. 그 브랜치로 체크아웃하면 나온다
    await expect(page.getByTestId("tc-demo-TC-0102")).toHaveCount(0);
    await branches.getByTestId("branch-qa/qa-bot/TC-0102-add-tc-0102").getByRole("button", { name: "체크아웃" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0102-add-tc-0102 로 체크아웃했습니다");
    await expect(page.getByTestId("tc-demo-TC-0102")).toBeVisible();

    // 지금 브랜치가 아닌 TC-0101 의 브랜치도 PR 을 만들 수 있다(브랜치는 그대로)
    await branches.getByTestId("branch-qa/qa-bot/TC-0101-title-wording").getByRole("button", { name: "PR 작성" }).click();
    await expect(page.getByTestId("tc-review-target")).toContainText("qa/qa-bot/TC-0101-title-wording");
    await page.getByLabel("PR 제목").fill("TC-0101 제목 다듬기");
    await page.getByRole("button", { name: "PR 올리기" }).click();
    await expect(page.getByTestId("tc-pr")).toContainText("PR #8 을 만들었습니다(qa/qa-bot/TC-0101-title-wording)");
    expect(remote.api.pulls[1]).toMatchObject({ head: "qa/qa-bot/TC-0101-title-wording", base: "main", title: "TC-0101 제목 다듬기" });
    // 올라간 TC-0101 브랜치에는 TC-0101 커밋만 있다
    expect(remote.git(remote.bare, "log", "--format=%s", "main..qa/qa-bot/TC-0101-title-wording").split("\n")).toEqual(["tc: TC-0101 title wording"]);
    await expect(branches.getByTestId("branch-qa/qa-bot/TC-0102-add-tc-0102")).toContainText("지금");
    await app.close();
  } finally {
    await remote.close();
  }
});
