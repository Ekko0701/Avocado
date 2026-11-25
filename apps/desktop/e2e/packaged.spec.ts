import { _electron as electron, expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 패키징한 .app 확인 (T-102, T-122). 먼저 패키징한다: pnpm --filter @qa/desktop package
// 실행: pnpm --filter @qa/desktop test:e2e:packaged
// 패키징한 앱은 테스트용 환경 변수(QA_USER_DATA_DIR 등)를 무시한다. 실제 앱 데이터(설치한 앱의 DB)를 새 스키마로 올리지 않게
// Chromium 스위치 --user-data-dir 로 임시 폴더를 준다
const APP = resolve(__dirname, "../dist/mac-arm64/Avocado.app/Contents/MacOS/Avocado");
const BIN = resolve(__dirname, "../dist/mac-arm64/Avocado.app/Contents/Resources/bin/avocado");
const VERSION = (JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string }).version;

test.skip(process.env["QA_E2E_PACKAGED"] !== "1", "QA_E2E_PACKAGED=1 일 때만 실행");

let dataDir: string;
test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "qa-packaged-"));
});
test.afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
const launch = () => electron.launch({ executablePath: APP, args: [`--user-data-dir=${dataDir}`] });

test("패키징한 앱이 뜨고 로컬 DB 를 최신 스키마로 연다", async () => {
  expect(existsSync(APP), `패키징 결과가 없다: ${APP}`).toBe(true);
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const isPackaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
    expect(isPackaged).toBe(true);
    const status = await page.evaluate(() => window.qa.db.status());
    expect(status.schemaVersion).toBe(status.latestVersion);
    expect(status.journalMode).toBe("wal");
    expect(status.path).toMatch(/qa-packaged-[^/]+\/db\.sqlite$/);
    await expect(page.getByRole("heading", { name: /^(홈|설정 마법사)$/ })).toBeVisible();
  } finally {
    await app.close();
  }
});

function listening(path: string): Promise<boolean> {
  return new Promise((ok) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.destroy();
      ok(true);
    });
    s.once("error", () => ok(false));
  });
}

function run(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok) => {
    execFile(file, args, { timeout: 30_000, env: { ...process.env, ...env } }, (error, out, err) => ok({ code: error ? Number(error.code ?? 1) : 0, out, err }));
  });
}

// 번들의 avocado 명령(T-122, ADR 0035 결정 6): 앱 실행 파일의 runAsNode 로 돌고, 방금 패키징한 앱에 붙는다. 소켓은 AVOCADO_SOCKET 으로 임시 앱 데이터의 것을 준다
test("번들의 bin/avocado qa options 가 종료 코드 0 이고 응답한 앱 버전이 패키징한 버전이다. 심볼릭 링크로 불러도 된다", async () => {
  expect(existsSync(BIN), `번들에 avocado 명령이 없다: ${BIN}`).toBe(true);
  const socket = join(dataDir, "mcp", "avocado.sock");
  const env = { AVOCADO_SOCKET: socket };
  // 마법사를 마친 상태로 띄워 설정 화면을 연다
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ version: 1, evidence: { retentionDays: 30 }, agent: { monthlyBudgetUsd: 100, judgeSampleRate: 0 }, devices: { locale: "ko_KR" }, policy: { evidenceUploadApproved: false }, setup: { completedAt: "2026-11-19T00:00:00.000Z" } }));
  const app = await launch();
  const linkDir = mkdtempSync(join(tmpdir(), "qa-packaged-cli-"));
  try {
    const page = await app.firstWindow();
    await expect.poll(() => listening(socket), { timeout: 30_000 }).toBe(true);
    // 설정의 터미널 구역이 이 번들의 명령을 거는 명령을 보인다(실제 ~/.local/bin 은 읽기만 한다)
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByTestId("settings-nav-terminal").click();
    await expect(page.getByTestId("terminal-link-command")).toContainText(`ln -sf '${BIN}' ~/.local/bin/avocado`);
    const direct = await run(BIN, ["qa", "options", "--json"], env);
    expect(direct.code, direct.err).toBe(0);
    expect((JSON.parse(direct.out) as { appVersion: string }).appVersion).toBe(VERSION);
    symlinkSync(BIN, join(linkDir, "avocado"));
    const linked = await run(join(linkDir, "avocado"), ["qa", "options", "--json"], env);
    expect(linked.code, linked.err).toBe(0);
    expect((JSON.parse(linked.out) as { appVersion: string }).appVersion).toBe(VERSION);
  } finally {
    await app.close();
    rmSync(linkDir, { recursive: true, force: true });
  }
  // 앱을 끄면 연결하지 못함(3)
  expect((await run(BIN, ["qa", "options"], env)).code).toBe(3);
});
