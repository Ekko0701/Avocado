import type { ElectronApplication, Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, type LaunchOptions } from "../e2e/launch";

const DESKTOP = resolve(__dirname, "..");
const REPO = resolve(DESKTOP, "../..");
/** 검증 증적을 두는 곳. 실행마다 <시각>-<이름> 폴더를 만들고, 정리할 때도 지우지 않는다 */
export const EVIDENCE_ROOT = process.env["QA_VERIFY_OUT"] ?? join(REPO, "out", "verify");

export interface VerifyRun {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** 이 실행의 증적 폴더 */
  dir: string;
  /** 지금 화면의 스크린샷과 ARIA 스냅숏을 단계 번호를 붙여 남긴다 */
  shot(label: string): Promise<void>;
  /** 화면 밖에서 확인한 것(원격 저장소, IPC 상태 등)을 notes.jsonl 에 남긴다 */
  note(label: string, data: unknown): void;
  /** 이 실행이 띄운 앱만 끄고 임시 앱 데이터를 지운다. 증적은 남긴다 */
  close(): Promise<void>;
}

export interface DoctorReport {
  version: string;
  electron: string;
  pid: number | undefined;
  userData: string;
  isolated: boolean;
  schema: string;
  bundleBuiltAt: string;
  newestSource: string;
  fresh: boolean;
}

/**
 * 빌드된 앱(out/)을 격리된 앱 데이터 폴더·테스트 암호화로 띄운다(e2e/launch.ts).
 * 사용자의 실제 앱 데이터(~/Library/Application Support/Avocado)와 키체인은 건드리지 않는다
 */
export async function startRun(name: string, options: LaunchOptions = {}): Promise<VerifyRun> {
  // 폴더 이름은 이 Mac 의 현지 시각(YYYYMMDD-HHMMSS)
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const dir = join(EVIDENCE_ROOT, `${stamp}-${name}`);
  mkdirSync(dir, { recursive: true });
  const { app, page, userDataDir } = await launchApp(options);
  // 닫은 뒤에는 app.process() 를 부를 수 없어 미리 잡아 둔다
  const child = app.process();
  const ownsUserData = options.userDataDir === undefined;
  let step = 0;
  page.on("console", (message) => appendFileSync(join(dir, "console.log"), `[${message.type()}] ${message.text()}\n`));
  return {
    app,
    page,
    userDataDir,
    dir,
    async shot(label) {
      step += 1;
      const base = join(dir, `${String(step).padStart(2, "0")}-${label}`);
      await page.screenshot({ path: `${base}.png` });
      writeFileSync(`${base}.aria.txt`, await page.locator("body").ariaSnapshot());
    },
    note(label, data) {
      appendFileSync(join(dir, "notes.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), label, data })}\n`);
    },
    async close() {
      try {
        await app.close();
      } finally {
        // 정상 종료가 안 됐을 때만 이 실행이 띄운 프로세스를 끝낸다(이름으로 찾아 죽이지 않는다)
        if (child.exitCode === null && child.signalCode === null) child.kill();
        if (ownsUserData && userDataDir.startsWith(tmpdir())) rmSync(userDataDir, { recursive: true, force: true });
      }
    },
  };
}

/** 이 인스턴스를 몰아도 되는가: 격리된 앱 데이터, 소스보다 새 빌드, 앱 정보·DB 응답. 결과는 doctor.json */
export async function doctor(run: VerifyRun): Promise<DoctorReport> {
  const info = await run.page.evaluate(() => window.qa.app.getInfo());
  const db = await run.page.evaluate(() => window.qa.db.status());
  const userData = await run.app.evaluate(({ app }) => app.getPath("userData"));
  const bundle = statSync(join(DESKTOP, "out", "main", "index.js")).mtime;
  const newest = newestMtime([join(DESKTOP, "src"), ...readdirSync(join(REPO, "packages")).map((p) => join(REPO, "packages", p, "src"))]);
  const report: DoctorReport = {
    version: info.version,
    electron: info.versions.electron,
    pid: run.app.process().pid,
    userData,
    isolated: userData === run.userDataDir && !userData.includes("Application Support"),
    schema: `${db.schemaVersion}/${db.latestVersion}`,
    bundleBuiltAt: bundle.toISOString(),
    newestSource: newest.toISOString(),
    fresh: bundle >= newest,
  };
  writeFileSync(join(run.dir, "doctor.json"), JSON.stringify(report, null, 2));
  if (!report.isolated) throw new Error(`앱 데이터 폴더가 격리되지 않았다: ${userData}`);
  if (!report.fresh) throw new Error("out/ 빌드가 소스보다 오래됐다. pnpm --filter @qa/desktop exec electron-vite build 를 먼저 한다");
  return report;
}

function newestMtime(dirs: string[]): Date {
  let newest = new Date(0);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "fixtures") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|css|html)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const mtime = statSync(path).mtime;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  for (const dir of dirs) {
    try {
      walk(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return newest;
}
