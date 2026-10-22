import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "./launch";

// 빌드된 앱(out/)을 띄워 보안 설정과 IPC 왕복을 실제 Electron 에서 확인한다.
// 실행: pnpm --filter @qa/desktop test:e2e (빌드 후 실행)

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  ({ app, page, userDataDir } = await launchApp());
});

test.afterAll(async () => {
  await app?.close();
});

test("창이 뜨고 main 이 준 앱 정보를 보여 준다", async () => {
  await expect(page).toHaveTitle("Avocado");
  await expect(page.getByTestId("electron-version")).toHaveText("44.6.0");
});

test("IPC 왕복: 화면에서 보낸 메시지가 main 을 거쳐 돌아온다", async () => {
  await page.getByLabel("IPC 확인 메시지").fill("안녕 QA");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByTestId("pong")).toHaveText("안녕 QA");
});

test("잘못된 IPC 입력은 main 이 거부한다", async () => {
  const result = await page.evaluate(async () => {
    try {
      await window.qa.app.ping({ message: "" });
      return "accepted";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(result).toContain("invalid-input");
});

test("렌더러에는 Node 와 범용 IPC 가 노출되지 않는다", async () => {
  const exposed = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w["require"],
      process: typeof w["process"],
      module: typeof w["module"],
      qaKeys: Object.keys(window.qa).sort(),
      appKeys: Object.keys(window.qa.app).sort(),
      secretKeys: Object.keys(window.qa.secrets).sort(),
      claudeKeys: Object.keys(window.qa.claude).sort(),
    };
  });
  expect(exposed).toEqual({
    require: "undefined",
    process: "undefined",
    module: "undefined",
    qaKeys: ["agent", "app", "builds", "claude", "db", "devices", "evidence", "remote", "runs", "secrets", "settings", "setup", "update", "workspace"],
    appKeys: ["getInfo", "openExternal", "ping"],
    secretKeys: ["delete", "list", "set"],
    // Claude 연결(ADR 0022)은 상태 읽기와 데스크톱 앱 등록만 연다
    claudeKeys: ["connectDesktop", "status"],
  });
});

test("렌더러 프로세스가 샌드박스에서 실행된다", async () => {
  // Electron 44 에는 창의 webPreferences 를 읽는 공개 API 가 없다.
  // 설정값은 단위 테스트(security.test.ts)가 검사하고, 여기서는 실제 프로세스 상태를 본다.
  const renderer = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const pid = win?.webContents.getOSProcessId();
    const metric = electronApp.getAppMetrics().find((m) => m.pid === pid);
    return { found: metric !== undefined, type: metric?.type, sandboxed: metric?.sandboxed };
  });
  expect(renderer).toEqual({ found: true, type: "Tab", sandboxed: true });
});

test("운영 빌드 CSP 가 걸려 있다", async () => {
  const csp = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
  );
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-eval");
});

test("로컬 DB 를 열고 최신 스키마로 마이그레이션한다", async () => {
  const status = await page.evaluate(() => window.qa.db.status());
  expect(status.schemaVersion).toBe(status.latestVersion);
  expect(status.journalMode).toBe("wal");
  expect(status.tables).toEqual(
    expect.arrayContaining(["run", "execution", "step", "agent_job", "judgement", "upload", "build", "device"]),
  );
  expect(status.path).toBe(join(userDataDir, "db.sqlite"));
  expect(existsSync(status.path)).toBe(true);
  await expect(page.getByTestId("db-status")).toContainText(`스키마 v${status.latestVersion}/${status.latestVersion}`);
});

// 페이지 이동을 시도하므로 이 파일의 마지막에 둔다(막힌 이동이 다음 테스트의 대기에 영향을 준다).
test("새 창과 외부 탐색을 막는다", async () => {
  const before = page.url();
  const opened = await page.evaluate(() => window.open("https://example.com") === null);
  expect(opened).toBe(true);
  await page.evaluate(() => {
    window.location.href = "https://example.com";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  expect(app.windows()).toHaveLength(1);
});
