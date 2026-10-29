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
    // 설정의 "새 버전 확인"을 누르면 다시 불러오지 않아도 맨 위 배너가 바로 뜬다
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByTestId("version-section").getByRole("button", { name: "새 버전 확인" }).click();
    await expect(page.getByTestId("version-section")).toContainText("최신 릴리스 v999.0.0");
    await expect(page.getByTestId("update-banner")).toContainText("새 버전 v999.0.0");
    const status = await page.evaluate(() => window.qa.update.status());
    expect(status).toMatchObject({ source: "Ekko0701/Avocado", latest: "v999.0.0", available: true, asset: { name: "Avocado-999.0.0-arm64.dmg" } });
    // 릴리스에 .zip 이 없으면 재시작으로 적용하지 못하고 설치 파일로 받는다(ADR 0027)
    expect(status.autoInstall).toMatchObject({ possible: false, ready: false });
    expect(status.autoInstall.reason).toContain(".zip");
    await expect(page.getByTestId("update-banner").getByRole("button", { name: "설치 파일 받기" })).toBeVisible();
    await expect(page.getByTestId("update-banner")).toContainText(".zip 이 없어 설치 파일(.dmg)로 받는다");
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => !r.authorized)).toBe(true);
    await expect(page.getByTestId("version-section")).toContainText("Ekko0701/Avocado 의 Releases 에서 확인");
    // SHA-256 이 맞지 않으면 열지 않는다(파일도 남기지 않음)
    const download = await page.evaluate(() => window.qa.update.download().then(() => "ok", (e: unknown) => String(e)));
    expect(download).toContain("SHA-256");
    await app.close();
  } finally {
    await fake.close();
  }
});

// 앱이 켜진 직후에는 main 이 시작 5초 뒤에 첫 확인을 한다. 그 결과도 다시 불러오지 않고 배너에 뜬다
test("새 버전 확인: 앱이 켜진 뒤 main 의 첫 확인 결과가 배너에 뜬다 (T-116)", async () => {
  const fake = await startFakeGitHub({
    token: TOKEN,
    repos: { "Ekko0701/Avocado": { push: false } },
    publicRepos: ["Ekko0701/Avocado"],
    release: { tag: "v999.0.0", assets: [{ name: "Avocado-999.0.0-arm64.dmg", content: Buffer.from("x") }] },
  });
  try {
    const { app, page } = await launchApp({ env: { QA_E2E_GITHUB_API: fake.url } });
    await expect(page.getByTestId("update-banner")).toHaveCount(0);
    // 자동 E2E 에서는 주기 확인이 꺼져 있어 main 의 확인을 직접 부른다(화면 이벤트 없이)
    await page.evaluate(() => window.qa.update.check());
    await expect(page.getByTestId("update-banner")).toContainText("새 버전 v999.0.0", { timeout: 10_000 });
    await app.close();
  } finally {
    await fake.close();
  }
});

// 패키징 안 된 앱은 스스로 바꿔 끼울 수 없다. 릴리스에 .zip 이 있어도 설치 파일로 받는다
test("재시작으로 적용(ADR 0027): 패키징 안 된 앱은 .zip 이 있어도 설치 파일로 받는다", async () => {
  const fake = await startFakeGitHub({
    token: TOKEN,
    repos: { "Ekko0701/Avocado": { push: false } },
    publicRepos: ["Ekko0701/Avocado"],
    release: {
      tag: "v999.0.0",
      assets: [
        { name: "Avocado-999.0.0-arm64.dmg", content: Buffer.from("x") },
        { name: "Avocado-999.0.0-arm64.zip", content: Buffer.from("y") },
        { name: "Avocado-999.0.0-arm64.zip.sha256", content: Buffer.from(`${"0".repeat(64)}  Avocado-999.0.0-arm64.zip\n`) },
      ],
    },
  });
  try {
    const { app, page } = await launchApp({ env: { QA_E2E_GITHUB_API: fake.url } });
    const status = await page.evaluate(() => window.qa.update.check());
    expect(status.autoInstall).toEqual({ possible: false, reason: "패키징한 macOS 앱에서만 재시작해서 업데이트한다", ready: false });
    await expect(page.getByTestId("update-banner").getByRole("button", { name: "설치 파일 받기" })).toBeVisible();
    // 받기 전에는 재시작할 것이 없다
    const install = await page.evaluate(() => window.qa.update.install().then(() => "ok", (e: unknown) => String(e)));
    expect(install).toContain("먼저 받는다");
    await app.close();
  } finally {
    await fake.close();
  }
});

// 실제 Squirrel.Mac 적용은 서명한 패키징 앱에서만 된다. 여기서는 main 의 업데이트 핸들러만 정해진 결과로 바꿔 화면 흐름을 본다
test("재시작으로 적용(ADR 0027): 받기 → 재시작해서 업데이트, 진행 중인 작업이 있으면 알린다", async () => {
  const { app, page } = await launchApp();
  await app.evaluate(({ ipcMain }) => {
    const base = {
      current: "0.1.7",
      source: "Ekko0701/Avocado",
      latest: "v0.1.8",
      available: true,
      checkedAt: new Date().toISOString(),
      release: { tag: "v0.1.8", name: "Avocado v0.1.8", url: "https://github.com/Ekko0701/Avocado/releases/tag/v0.1.8", publishedAt: null },
      asset: { name: "Avocado-0.1.8-arm64.dmg", size: 1 },
      error: null,
      downloaded: null,
      busy: false,
    };
    let ready = false;
    let installs = 0;
    const status = () => ({ ...base, autoInstall: { possible: true, reason: null, ready } });
    (globalThis as unknown as { updateInstalls: () => number }).updateInstalls = () => installs;
    const swap = (channel: string, handler: () => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    swap("update:status", status);
    swap("update:check", status);
    swap("update:download", () => {
      ready = true;
      return status();
    });
    swap("update:install", () => {
      installs += 1;
      // 처음 한 번은 실행이 진행 중이라 거절한다
      if (installs === 1) throw new Error("플로우 실행이 진행 중이다. 끝난 뒤 재시작한다");
      return status();
    });
  });
  await page.evaluate(() => window.qa.update.check());
  const banner = page.getByTestId("update-banner");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByTestId("version-section").getByRole("button", { name: "새 버전 확인" }).click();
  await expect(banner).toContainText("새 버전 v0.1.8");
  await banner.getByRole("button", { name: "받기", exact: true }).click();
  await expect(banner).toContainText("준비됐습니다. 재시작하면 새 버전이 적용됩니다");
  await banner.getByRole("button", { name: "재시작해서 업데이트" }).click();
  await expect(banner).toContainText("재시작하지 못했습니다: 플로우 실행이 진행 중이다. 끝난 뒤 재시작한다");
  await banner.getByRole("button", { name: "재시작해서 업데이트" }).click();
  await expect(banner).toContainText("재시작합니다");
  expect(await app.evaluate(() => (globalThis as unknown as { updateInstalls: () => number }).updateInstalls())).toBe(2);
  await app.close();
});
