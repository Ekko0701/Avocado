import { expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}

test("실행 화면: 선택 창으로 고른 플로우만 실행할 수 있고, main 이 잘못된 요청을 거부한다", async () => {
  const work = mkdtempSync(join(tmpdir(), "qa-e2e-runs-"));
  const flow = join(work, "TC-0009.yaml");
  writeFileSync(flow, "appId: com.apple.Preferences\nname: TC-0009 설정 열기\ntags: [TC-0009]\n---\n- launchApp\n");
  const other = join(work, "other.yaml");
  writeFileSync(other, "appId: com.apple.Preferences\n---\n- launchApp\n");
  const notFlow = join(work, "notes.yaml");
  writeFileSync(notFlow, "just: text\n");

  const { app, page } = await launchApp();
  await page.getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.getByText("실행 기록이 없습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "실행", exact: true }).nth(1)).toBeDisabled();

  // 플로우가 아닌 파일
  await stubOpenDialog(app, notFlow);
  await page.getByRole("button", { name: "플로우 선택" }).click();
  await expect(page.getByTestId("run-message")).toContainText("플로우를 읽지 못했습니다");

  // 선택 창으로 고른 플로우
  await stubOpenDialog(app, flow);
  await page.getByRole("button", { name: "플로우 선택" }).click();
  await expect(page.getByTestId("picked-flow")).toContainText("TC-0009 설정 열기");
  await expect(page.getByTestId("picked-flow")).toContainText("TC-0009");

  // 화면을 우회한 요청: 고르지 않은 경로, 덧붙인 필드, 없는 실행, 도구 미설치
  expect(await page.evaluate((p) => window.qa.runs.start({ app: "settings", flowPath: p, deviceId: "x", buildId: null }).then(() => "accepted", (e: unknown) => String(e)), other)).toContain(
    "선택 창으로 고르거나 워크스페이스",
  );
  expect(
    await page.evaluate((p) =>
      (window.qa.runs.start as (i: unknown) => Promise<unknown>)({ app: "settings", flowPath: p, deviceId: "x", buildId: null, env: { A: "1" } }).then(
        () => "accepted",
        (e: unknown) => String(e),
      ),
    flow),
  ).toContain("invalid-input");
  expect(await page.evaluate(() => window.qa.runs.get({ runId: "nope" }).then(() => "accepted", (e: unknown) => String(e)))).toContain("실행을 찾지 못했다");
  // 이 데이터 폴더에는 앱 관리 Maestro 가 없다
  expect(await page.evaluate((p) => window.qa.runs.start({ app: "settings", flowPath: p, deviceId: "x", buildId: null }).then(() => "accepted", (e: unknown) => String(e)), flow)).toContain(
    "설치되지 않았다",
  );
  expect(await page.evaluate(() => window.qa.runs.list())).toEqual([]);
  await app.close();
});
