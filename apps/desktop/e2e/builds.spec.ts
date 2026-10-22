import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeApp, makeScript } from "../test-support/fake-builds";
import { launchApp } from "./launch";

/** main 의 파일 선택 창을 정해진 결과로 바꾼다. 실제 창은 자동화할 수 없다. */
async function stubOpenDialog(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () =>
      Promise.resolve(picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] });
  }, path);
}

test("빌드 등록: 화면에서 파일·스크립트로 등록하면 앱 데이터에 복사되고 재시작 후에도 남는다", async () => {
  const work = mkdtempSync(join(tmpdir(), "qa-e2e-builds-"));
  const first = await launchApp();
  const { app, page, userDataDir } = first;
  await page.getByRole("button", { name: "빌드", exact: true }).click();
  await expect(page.getByText("등록한 빌드가 없습니다.")).toBeVisible();

  // 앱 ID 가 형식에 맞아야 버튼이 열린다
  const register = page.getByRole("button", { name: "파일로 등록" });
  await page.getByLabel("앱 ID").fill("Sample!");
  await expect(register).toBeDisabled();
  await expect(page.getByText("소문자·숫자·하이픈만")).toBeVisible();
  await page.getByLabel("앱 ID").fill("sample");
  await expect(register).toBeEnabled();

  // 선택 창을 취소하면 아무것도 등록하지 않는다
  await stubOpenDialog(app, null);
  await register.click();
  await expect(page.getByText("등록한 빌드가 없습니다.")).toBeVisible();

  // 파일로 등록
  const src = makeFakeApp(join(work, "src"), { name: "Sample", bundleId: "com.example.sample.dev", version: "1.2.3", build: "1" });
  await stubOpenDialog(app, src);
  await register.click();
  await expect(page.getByTestId("build-message")).toHaveText("등록했습니다: com.example.sample.dev 1.2.3 (1)");

  // 스크립트로 등록: 스크립트가 QA_BUILD_INFO 에 결과물을 적는다
  const out = makeFakeApp(join(work, "out"), { name: "Built", bundleId: "net.example.built", version: "2.0.0", build: "9" });
  const script = makeScript(work, `printf 'ARTIFACT=%s\\nCOMMIT=0123456789abcdef\\n' "${out}" > "$QA_BUILD_INFO"`);
  await stubOpenDialog(app, script);
  await page.getByRole("button", { name: "빌드 스크립트 실행" }).click();
  await expect(page.getByTestId("build-message")).toHaveText("등록했습니다: net.example.built 2.0.0 (9)");

  const builds = await page.evaluate(() => window.qa.builds.list());
  expect(builds.map((b) => [b.appId, b.source, b.commit])).toEqual([
    ["net.example.built", "script", "0123456789abcdef"],
    ["com.example.sample.dev", "file", null],
  ]);
  for (const b of builds) {
    expect(b.path.startsWith(join(userDataDir, "builds"))).toBe(true);
    expect(existsSync(join(b.path, "Info.plist"))).toBe(true);
    await expect(page.getByTestId(`build-${b.id}`)).toContainText(`${b.appId} ${b.version} (${b.buildNumber})`);
  }

  // 2단계 방어: 화면을 우회한 IPC 호출도 main 이 거부한다. 렌더러는 경로를 넘길 수 없다(CLAUDE.md 5장).
  const badApp = await page.evaluate(() => window.qa.builds.pickAndRegister({ app: "../etc" }).then(() => "accepted", (e: unknown) => String(e)));
  expect(badApp).toContain("invalid-input");
  const smuggledPath = await page.evaluate(() =>
    (window.qa.builds.runScript as (i: unknown) => Promise<unknown>)({ app: "sample", scriptPath: "/bin/sh" }).then(() => "accepted", (e: unknown) => String(e)),
  );
  expect(smuggledPath).toContain("invalid-input");
  expect(await page.evaluate(() => "registerPath" in window.qa.builds)).toBe(false);
  const install = await page.evaluate(async (buildId) => {
    try {
      await window.qa.builds.install({ buildId, deviceId: "no-such-device" });
      return "accepted";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, builds[0]?.id ?? "");
  expect(install).toContain("기기를 찾지 못했다");
  await app.close();

  const second = await launchApp({ userDataDir });
  await second.page.getByRole("button", { name: "빌드", exact: true }).click();
  for (const b of builds) await expect(second.page.getByTestId(`build-${b.id}`)).toBeVisible();
  await second.app.close();
});
