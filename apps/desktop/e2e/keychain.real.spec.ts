import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "./launch";

// 실제 macOS 키체인(safeStorage)으로 저장되는지 확인한다. 기본 실행에서는 건너뛴다.
// macOS 가 키체인 접근 허용 창을 띄울 수 있으므로 사람이 있을 때만 켠다:
//   QA_E2E_REAL_KEYCHAIN=1 pnpm --filter @qa/desktop test:e2e
// 앱 키체인 항목("<앱 이름> Safe Storage")이 로그인 키체인에 만들어진다(실제 사용 때와 같다).
function readDirRecursive(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? readDirRecursive(path) : readFileSync(path).toString("latin1");
    })
    .join("\n");
}

test.skip(process.env["QA_E2E_REAL_KEYCHAIN"] !== "1", "QA_E2E_REAL_KEYCHAIN=1 일 때만 실행");

test("실제 safeStorage 로 암호화해 저장하고 평문을 남기지 않는다", async () => {
  const value = `real-keychain-check-${Date.now()}`;
  const { app, page, userDataDir } = await launchApp({ realKeychain: true });
  const list = await page.evaluate(() => window.qa.secrets.list());
  expect(list.encryptionAvailable).toBe(true);
  await page.evaluate((v) => window.qa.secrets.set({ name: "githubToken", value: v }), value);
  await app.close();

  const secretsFile = readFileSync(join(userDataDir, "secrets.json"), "utf8");
  expect(secretsFile).toContain("githubToken");
  expect(readDirRecursive(userDataDir)).not.toContain(value);
  // 테스트 전용 암호화 표식이 없어야 실제 safeStorage 로 암호화된 것이다
  const cipher = Buffer.from(JSON.parse(secretsFile).items.githubToken.ciphertext, "base64").toString("latin1");
  expect(cipher.startsWith("QA-TEST-ONLY:")).toBe(false);

  const again = await launchApp({ userDataDir, realKeychain: true });
  const status = await again.page.evaluate(() => window.qa.secrets.list());
  expect(status.items.find((i) => i.name === "githubToken")?.stored).toBe(true);
  await again.page.evaluate(() => window.qa.secrets.delete({ name: "githubToken" }));
  await again.app.close();
});
