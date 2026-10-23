import { expect, test } from "@playwright/test";
import { startFakeGitHub } from "../../../packages/remote/src/testing/fake-github";
import { launchApp } from "./launch";

const TOKEN = "ghp_e2e_fake_update_token_000000000000000";

// 패키징 전 실행에서는 app.getVersion() 이 Electron 버전(44.x)이라 아주 높은 태그를 쓴다.
// 새 버전은 GitHub 토큰·조직 설정 없이 공개 배포 저장소(update/trust.ts)에서 확인한다
test("새 버전 확인: 최신 릴리스가 더 새로우면 배너가 뜬다 (T-116)", async () => {
  const fake = await startFakeGitHub({
    token: TOKEN,
    repos: { "Ekko0701/Avocado": { push: false } },
    publicRepos: ["Ekko0701/Avocado"],
    release: {
      tag: "v999.0.0",
      assets: [
        { name: "Avocado-999.0.0-arm64.dmg", content: Buffer.from("not a real dmg") },
        { name: "Avocado-999.0.0-arm64.dmg.sha256", content: Buffer.from(`${"0".repeat(64)}  Avocado-999.0.0-arm64.dmg\n`) },
      ],
    },
  });
  try {
    const { app, page } = await launchApp({ env: { QA_E2E_GITHUB_API: fake.url } });
    await expect(page.getByTestId("update-banner")).toHaveCount(0);
    const status = await page.evaluate(() => window.qa.update.check());
    expect(status).toMatchObject({ source: "Ekko0701/Avocado", latest: "v999.0.0", available: true, asset: { name: "Avocado-999.0.0-arm64.dmg" } });
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => !r.authorized)).toBe(true);
    await page.reload();
    await expect(page.getByTestId("update-banner")).toContainText("새 버전 v999.0.0");
    // 설정의 버전 칸에도 최신 릴리스가 보인다
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("version-section")).toContainText("최신 릴리스 v999.0.0");
    await expect(page.getByTestId("version-section")).toContainText("Ekko0701/Avocado 의 Releases 에서 확인");
    // SHA-256 이 맞지 않으면 열지 않는다(파일도 남기지 않음)
    const download = await page.evaluate(() => window.qa.update.download().then(() => "ok", (e: unknown) => String(e)));
    expect(download).toContain("SHA-256");
    await app.close();
  } finally {
    await fake.close();
  }
});
