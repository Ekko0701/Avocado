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
    const github = page.getByRole("form", { name: "GitHub" });
    const check = github.getByRole("button", { name: "연결 확인" });
    await expect(check).toBeDisabled();

    const tokenRow = page.getByTestId("secret-githubToken");
    await tokenRow.getByLabel("GitHub 토큰 입력").fill(TOKEN);
    await tokenRow.getByRole("button", { name: "저장" }).click();
    await expect(tokenRow.getByTestId("secret-status")).toHaveText("저장됨");
    await expect(check).toBeDisabled(); // 조직 이름이 아직 없다
    await github.getByLabel("GitHub 조직").fill("acme");
    await github.getByRole("button", { name: "저장", exact: true }).click();
    await expect(github.getByRole("status")).toHaveText("저장했습니다");

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
    await expect(github.getByRole("status")).toContainText("토큰이 유효하지 않거나");
    await expect(github.getByRole("status")).not.toContainText("WRONG");
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
    const github = page.getByRole("form", { name: "GitHub" });
    const picker = github.getByTestId("github-repo-picker");
    await expect(picker.getByRole("button", { name: "저장소 목록 불러오기" })).toBeDisabled();
    const tokenRow = page.getByTestId("secret-githubToken");
    await tokenRow.getByLabel("GitHub 토큰 입력").fill(TOKEN);
    await tokenRow.getByRole("button", { name: "저장" }).click();
    await expect(tokenRow.getByTestId("secret-status")).toHaveText("저장됨");

    await picker.getByRole("button", { name: "저장소 목록 불러오기" }).click();
    // 연도로 끝나는 증적 저장소가 없는 주인을 고르면 알려 준다
    await picker.getByLabel("워크스페이스(테스트 케이스·플로우)").selectOption("other/no-year");
    await expect(picker.getByTestId("github-picker-no-evidence")).toContainText("연도로 끝나는 증적 저장소");
    await expect(picker.getByRole("button", { name: "고른 저장소로 저장" })).toBeDisabled();

    await picker.getByLabel("워크스페이스(테스트 케이스·플로우)").selectOption("me/Avocado-workspace");
    await picker.getByLabel("증적(연도별)").selectOption(`Avocado-qa-evidence-${year}`);
    await picker.getByRole("button", { name: "고른 저장소로 저장" }).click();
    await expect(github.getByLabel("GitHub 조직")).toHaveValue("me");
    await expect(github.getByLabel("워크스페이스 저장소")).toHaveValue("Avocado-workspace");
    await expect(github.getByLabel("증적 저장소 접두사")).toHaveValue("Avocado-qa-evidence-");
    expect(await page.evaluate(() => window.qa.settings.get().then((s) => s.settings.github))).toEqual({
      owner: "me",
      workspaceRepo: "Avocado-workspace",
      evidenceRepoPrefix: "Avocado-qa-evidence-",
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
