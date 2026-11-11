import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeApp, makeScript } from "../test-support/fake-builds";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYBLD_0123456789abcdefghijkl";

// 빌드: 버전이 같은 빌드 둘을 등록해도 어디서 왔는지와 만든 시각으로 구분되고(빌드 목록, 실행·플로우 만들기의 빌드 고르기), 확인 뒤 지울 수 있다.
// 빌드는 Info.plist 만 있는 가짜 .app 이다. 프로젝트 빌드의 "스킴 · 구성" 이름표는 실제 xcodebuild 가 있어야 해서 이 여정 밖이다
test("빌드: 같은 버전의 빌드 구분과 삭제", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const work = mkdtempSync(join(tmpdir(), "qa-verify-builds-"));
  const run = await startRun("builds", { env: remote.env });
  try {
    await doctor(run);
    const { page } = run;
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "빌드", exact: true }).click();

    // 같은 앱 ID·버전·빌드 번호로 두 번 등록한다: 파일로 한 번, 빌드 스크립트로 한 번
    const fromFile = makeFakeApp(join(work, "file"), { name: "Demo", bundleId: "com.example.demo.dev", version: "1.0", build: "1" });
    const fromScript = makeFakeApp(join(work, "script"), { name: "Demo", bundleId: "com.example.demo.dev", version: "1.0", build: "1" });
    const script = makeScript(work, `printf 'ARTIFACT=%s\\nCOMMIT=0123456789abcdef0123456789abcdef01234567\\n' "${fromScript}" > "$QA_BUILD_INFO"`);
    await page.getByLabel("앱 ID").selectOption("demo").catch(() => page.getByLabel("앱 ID").fill("demo"));
    await stubOpenDialog(run.app, fromFile);
    await page.getByRole("button", { name: "파일로 등록" }).click();
    await expect(page.getByTestId("build-message")).toContainText("등록했습니다");
    await stubOpenDialog(run.app, script);
    await page.getByRole("tab", { name: "스크립트" }).click();
    await page.getByRole("button", { name: "빌드 스크립트 실행" }).click();
    await expect(page.getByTestId("build-message")).toContainText("등록했습니다");
    const builds = await page.evaluate(() => window.qa.builds.list());
    expect(builds.map((b) => `${b.appId} ${b.version} (${b.buildNumber})`)).toEqual(["com.example.demo.dev 1.0 (1)", "com.example.demo.dev 1.0 (1)"]);
    const [scripted, filed] = builds;
    if (!scripted || !filed) throw new Error("빌드가 둘이어야 한다");
    await expect(page.getByTestId(`build-${filed.id}`)).toContainText("파일 · ");
    await expect(page.getByTestId(`build-${scripted.id}`)).toContainText("스크립트 · 0123456789");
    await run.shot("two-builds");
    // 프로젝트 탭, 넓은 창(목록 줄이 한 줄), 페이지가 창 높이에 맞는지
    await page.getByRole("tab", { name: "프로젝트" }).click();
    await expect(page.getByTestId("project-build")).toBeVisible();
    await run.shot("project-tab");
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.waitForTimeout(500);
    await run.shot("wide");
    run.note("main-fits", await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? { scroll: main.scrollHeight, client: main.clientHeight } : null;
    }));
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 760));
    await page.waitForTimeout(500);
    await run.shot("narrow");
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));
    await page.waitForTimeout(300);

    // 고르는 목록에서도 구분된다
    await nav.getByRole("button", { name: "실행", exact: true }).click();
    await page.getByTestId("run-setup").getByLabel("실행할 앱").selectOption("demo");
    // "기기에 설치된 앱" + 빌드 둘이 불러와질 때까지 기다린다
    await expect(page.getByTestId("run-setup").getByLabel("실행 빌드").locator("option")).toHaveCount(3);
    const options = await page.getByTestId("run-setup").getByLabel("실행 빌드").locator("option").allTextContents();
    run.note("run-build-options", options);
    expect(options.filter((o) => o.startsWith("1.0 (1) · "))).toHaveLength(2);
    expect(new Set(options).size).toBe(options.length);
    expect(options.some((o) => o.includes("파일로 등록"))).toBe(true);
    expect(options.some((o) => o.includes("빌드 스크립트 · 0123456"))).toBe(true);
    await page.getByTestId("run-setup").getByLabel("실행 빌드").selectOption(scripted.id);
    await run.shot("run-build-picked");

    // 삭제: 확인을 거쳐 지운다. 사본 폴더도 사라진다
    await nav.getByRole("button", { name: "빌드", exact: true }).click();
    const row = page.getByTestId(`build-${filed.id}`);
    await row.getByRole("button", { name: /^빌드 삭제/ }).click();
    await page.waitForTimeout(200);
    await run.shot("confirm-delete");
    await row.getByRole("button", { name: "정말 삭제" }).click();
    await expect(page.getByTestId("build-message")).toContainText("지웠습니다: com.example.demo.dev 1.0 (1) · 파일로 등록");
    await expect(page.getByTestId(`build-${filed.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`build-${scripted.id}`)).toBeVisible();
    await run.shot("deleted");
    expect(existsSync(filed.path)).toBe(false);
    expect(existsSync(scripted.path)).toBe(true);
    run.note("after-delete", { left: (await page.evaluate(() => window.qa.builds.list())).map((b) => b.id), removedPathExists: existsSync(filed.path) });
  } finally {
    await run.close();
    await remote.close();
    rmSync(work, { recursive: true, force: true });
  }
});

/** 파일 선택 창은 자동화할 수 없어 main 의 대화상자를 바꾼다(e2e/builds.spec.ts 와 같다) */
async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}
