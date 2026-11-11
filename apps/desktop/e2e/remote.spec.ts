import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startFakeGitHub } from "../../../packages/remote/src/testing/fake-github";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2E_0123456789abcdefghijklmnopqrstuvwx";

function allText(dir: string): string {
  return readdirSync(dir)
    .map((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? allText(p) : readFileSync(p).toString("latin1");
    })
    .join("\n");
}

test("GitHub 연결 확인: 토큰은 헤더로만 가고 화면·로그·데이터 폴더에 평문으로 남지 않는다", async () => {
  const year = new Date().getFullYear();
  const fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-workspace": { push: true }, [`acme/qa-evidence-${year}`]: { push: false } } });
  try {
    const { app, page, userDataDir } = await launchApp({ env: { QA_E2E_GITHUB_API: fake.url } });
    await page.getByRole("button", { name: "설정", exact: true }).click();
    const github = page.getByRole("region", { name: "GitHub" });
    const foot = github.getByTestId("settings-foot");
    const check = github.getByRole("button", { name: "연결 확인" });
    await expect(check).toBeDisabled();

    const tokenRow = page.getByTestId("secret-githubToken");
    await tokenRow.getByLabel("GitHub 토큰 입력").fill(TOKEN);
    await tokenRow.getByRole("button", { name: "저장" }).click();
    await expect(tokenRow.getByTestId("secret-status")).toHaveText("저장됨");
    await expect(check).toBeDisabled(); // 조직 이름이 아직 없다
    await github.getByLabel("GitHub 조직").fill("acme");
    await foot.getByRole("button", { name: "저장", exact: true }).click();
    await expect(foot.getByRole("status")).toHaveText("저장했습니다");
    // 구역 목록의 상태 줄도 바뀐다
    await expect(page.getByTestId("settings-nav-github")).toContainText("acme/qa-workspace");

    await check.click();
    const result = page.getByTestId("github-verify");
    await expect(result).toContainText("qa-bot");
    await expect(result).toContainText("acme/qa-workspace");
    await expect(result.locator("li", { hasText: "acme/qa-workspace" })).toContainText("쓰기 가능");
    await expect(result.locator("li", { hasText: `acme/qa-evidence-${year}` })).toContainText("읽기만");
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.authorized)).toBe(true);
    expect(await page.content()).not.toContain(TOKEN);

    // 틀린 토큰: 토큰 없는 오류
    await tokenRow.getByLabel("GitHub 토큰 입력").fill("github_pat_WRONG_000000000000000000000000000");
    await tokenRow.getByRole("button", { name: "저장" }).click();
    await check.click();
    await expect(foot.getByRole("status")).toContainText("토큰이 유효하지 않거나");
    await expect(foot.getByRole("status")).not.toContainText("WRONG");
    await app.close();

    const disk = allText(userDataDir);
    expect(disk).not.toContain(TOKEN);
    expect(disk).not.toContain("github_pat_WRONG");
    const log = readFileSync(join(userDataDir, "logs", "remote.log"), "utf8");
    expect(log).toContain('"path":"/user"');
    expect(log).not.toMatch(/authorization|token /i);
  } finally {
    await fake.close();
  }
});

test("저장소 고르기: 사용자마다 다른 저장소 이름을 토큰으로 볼 수 있는 목록에서 고르면 설정에 저장한다", async () => {
  const year = new Date().getFullYear();
  const fake = await startFakeGitHub({
    token: TOKEN,
    repos: { "me/Avocado-workspace": { push: true }, [`me/Avocado-qa-evidence-${year}`]: { push: true }, "me/Avocado": { push: true }, "other/no-year": { push: true } },
  });
  try {
    const { app, page } = await launchApp({ env: { QA_E2E_GITHUB_API: fake.url } });
    await page.getByRole("button", { name: "설정", exact: true }).click();
    const github = page.getByRole("region", { name: "GitHub" });
    const picker = github.getByTestId("github-repo-picker");
    await expect(picker.getByRole("button", { name: "저장소 목록 불러오기" })).toBeDisabled();
    const tokenRow = page.getByTestId("secret-githubToken");
    await tokenRow.getByLabel("GitHub 토큰 입력").fill(TOKEN);
    await tokenRow.getByRole("button", { name: "저장" }).click();
    await expect(tokenRow.getByTestId("secret-status")).toHaveText("저장됨");

    await picker.getByRole("button", { name: "저장소 목록 불러오기" }).click();
    const evidence = picker.getByLabel("증적 저장소 고르기");
    await expect(picker.getByRole("button", { name: "고른 저장소로 저장" })).toBeDisabled();
    await picker.getByLabel("워크스페이스(테스트 케이스·플로우)").selectOption("me/Avocado-workspace");
    // 증적 저장소는 토큰으로 볼 수 있는 어느 저장소든 고를 수 있다(ADR 0033): 연도로 끝나지 않아도, 주인이 달라도 된다
    expect(await evidence.locator("option").allTextContents()).toEqual(["선택", "me/Avocado", `me/Avocado-qa-evidence-${year}`, "me/Avocado-workspace", "other/no-year"]);
    await evidence.selectOption("other/no-year");
    await expect(picker.getByTestId("github-picker-evidence-mode")).toContainText("해가 바뀌어도 other/no-year 하나에 계속 올립니다");
    await expect(picker).toContainText("증적 저장소의 주인(other)이 워크스페이스(me)와 다릅니다");
    await picker.getByRole("button", { name: "고른 저장소로 저장" }).click();
    await expect(github.getByLabel("증적 저장소", { exact: true })).toHaveValue("no-year");
    await expect(github.getByLabel("증적 저장소 주인(워크스페이스와 다를 때만)")).toHaveValue("other");
    expect(await page.evaluate(() => window.qa.settings.get().then((s) => s.settings.github))).toEqual({
      owner: "me",
      workspaceRepo: "Avocado-workspace",
      evidenceRepoPrefix: "qa-evidence-",
      evidenceRepo: "no-year",
      evidenceOwner: "other",
    });
    await github.getByRole("button", { name: "연결 확인" }).click();
    await expect(page.getByTestId("github-verify").locator("li", { hasText: "other/no-year" })).toContainText("쓰기 가능");

    // 연도로 끝나는 저장소를 고르면 연도별로 쓴다(접두사만 저장)
    await evidence.selectOption(`me/Avocado-qa-evidence-${year}`);
    await expect(picker.getByTestId("github-picker-evidence-mode")).toContainText(`연도별로 씁니다: 올해는 Avocado-qa-evidence-${year}`);
    await picker.getByRole("button", { name: "고른 저장소로 저장" }).click();
    await expect(github.getByLabel("GitHub 조직")).toHaveValue("me");
    await expect(github.getByLabel("워크스페이스 저장소")).toHaveValue("Avocado-workspace");
    await expect(github.getByLabel("증적 저장소", { exact: true })).toHaveValue(`Avocado-qa-evidence-${year}`);
    await expect(github.getByLabel("증적 저장소 주인(워크스페이스와 다를 때만)")).toHaveValue("");
    expect(await page.evaluate(() => window.qa.settings.get().then((s) => s.settings.github))).toEqual({
      owner: "me",
      workspaceRepo: "Avocado-workspace",
      evidenceRepoPrefix: "Avocado-qa-evidence-",
      evidenceRepo: null,
      evidenceOwner: null,
    });

    // 고른 이름으로 연결 확인이 된다
    await github.getByRole("button", { name: "연결 확인" }).click();
    await expect(page.getByTestId("github-verify")).toContainText("me/Avocado-workspace");
    await expect(page.getByTestId("github-verify").locator("li", { hasText: `me/Avocado-qa-evidence-${year}` })).toContainText("쓰기 가능");
    await app.close();
  } finally {
    await fake.close();
  }
});
