import { expect, test } from "@playwright/test";
import { startFakeGitHub } from "../../../packages/remote/src/testing/fake-github";
import { doctor, startRun } from "./harness";

// 설정의 "새 버전 확인" → 맨 위 배너. 패키징 안 된 앱은 재시작으로 적용하지 못하므로 "설치 파일 받기"와 그 이유가 보여야 한다.
// 패키징 안 된 앱의 버전은 Electron 버전(44.x)이라 아주 높은 태그를 쓴다
test("새 버전 확인: 배너와 받는 방법(재시작 또는 설치 파일)", async () => {
  const fake = await startFakeGitHub({
    token: "ghp_verify_fake_update_token_0000000000000",
    repos: { "Ekko0701/Avocado": { push: false } },
    publicRepos: ["Ekko0701/Avocado"],
    release: {
      tag: "v999.0.0",
      assets: [
        { name: "Avocado-999.0.0-arm64.dmg", content: Buffer.from("x") },
        { name: "Avocado-999.0.0-arm64.dmg.sha256", content: Buffer.from(`${"0".repeat(64)}  Avocado-999.0.0-arm64.dmg\n`) },
        { name: "Avocado-999.0.0-arm64.zip", content: Buffer.from("y") },
        { name: "Avocado-999.0.0-arm64.zip.sha256", content: Buffer.from(`${"0".repeat(64)}  Avocado-999.0.0-arm64.zip\n`) },
      ],
    },
  });
  const run = await startRun("update", { env: { QA_E2E_GITHUB_API: fake.url } });
  try {
    await doctor(run);
    const { page } = run;
    await expect(page.getByTestId("update-banner")).toHaveCount(0);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByTestId("version-section").getByRole("button", { name: "새 버전 확인" }).click();
    const banner = page.getByTestId("update-banner");
    await expect(banner).toContainText("새 버전 v999.0.0");
    await expect(banner.getByRole("button", { name: "설치 파일 받기" })).toBeVisible();
    await expect(banner).toContainText("패키징한 macOS 앱에서만 재시작해서 업데이트한다");
    await run.shot("banner");
    const status = await page.evaluate(() => window.qa.update.status());
    expect(status).toMatchObject({ latest: "v999.0.0", available: true, autoInstall: { possible: false, ready: false } });
    run.note("update-status", status);
    // 공개 배포 저장소는 토큰 없이 확인한다
    expect(fake.requests.every((r) => !r.authorized)).toBe(true);
  } finally {
    await run.close();
    await fake.close();
  }
});
