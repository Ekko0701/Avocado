import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

// 디자인 확인용 화면 캡처. QA_SCREENSHOTS_DIR=<폴더> 일 때만 돈다. 주요 화면을 라이트·다크 두 벌로 남긴다.
//   QA_SCREENSHOTS_DIR=$PWD/out/screens pnpm --filter @qa/desktop exec playwright test e2e/screens.spec.ts
const OUT = process.env["QA_SCREENSHOTS_DIR"];
test.skip(!OUT, "QA_SCREENSHOTS_DIR 일 때만 실행");

const TOKEN = "github_pat_E2ESCREENS_0123456789abcdefghijklmn";
const PAGES: [label: string, file: string][] = [
  ["홈", "home"],
  ["워크스페이스", "workspace"],
  ["TC", "tc"],
  ["플로우 만들기", "author"],
  ["실행", "runs"],
  ["결과", "results"],
  ["기기", "devices"],
  ["빌드", "builds"],
  ["설정 마법사", "setup"],
  ["설정", "settings"],
];

test("주요 화면 캡처(라이트·다크)", async () => {
  test.setTimeout(120_000);
  const dir = OUT ?? "";
  mkdirSync(dir, { recursive: true });
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [label, file] of PAGES) {
        await nav.getByRole("button", { name: label, exact: true }).click();
        if (file === "tc") await page.getByRole("button", { name: "demo/TC-0101" }).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `${scheme}-${file}.png`) });
      }
    }
    await app.close();
  } finally {
    await remote.close();
  }
});
