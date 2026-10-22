import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "./launch";

// 실제 JRE(약 45MB)·Maestro(약 300MB)를 고정 URL 에서 내려받아 설치하고 실행까지 확인한다.
// 새 데이터 폴더에서 마법사만으로 Maestro 가 실행되는지 보는 T-103 완료 기준 확인용.
//   QA_E2E_REAL_INSTALL=1 pnpm --filter @qa/desktop exec playwright test e2e/setup.real.spec.ts
test.skip(process.env["QA_E2E_REAL_INSTALL"] !== "1", "QA_E2E_REAL_INSTALL=1 일 때만 실행");

test("새 데이터 폴더에서 마법사만으로 실제 JRE·Maestro 를 설치하고 실행한다", async () => {
  test.setTimeout(20 * 60_000);
  const { app, page, userDataDir } = await launchApp({ setupCompleted: false });
  await page.getByRole("region", { name: "Claude 연결 단계" }).getByRole("button", { name: "다음" }).click();
  await page.getByRole("region", { name: "GitHub 토큰 단계" }).getByRole("button", { name: "건너뛰기" }).click();

  const env = page.getByRole("region", { name: "환경 점검 단계" });
  await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("필요", { timeout: 60_000 });
  await env.getByRole("button", { name: "필요한 도구 모두 설치" }).click();
  await expect(env.getByTestId("check-tool-maestro").getByTestId("check-status")).toHaveText("정상", {
    timeout: 18 * 60_000,
  });
  await env.getByRole("button", { name: "Maestro 실행 확인" }).click();
  await expect(env.getByTestId("maestro-verify")).toHaveText("Maestro 2.11.0 실행됨", { timeout: 120_000 });
  expect(existsSync(join(userDataDir, "tools", "maestro-2.11.0", "maestro", "bin", "maestro"))).toBe(true);
  await app.close();
});
