import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

export interface LaunchOptions {
  /** 기존 데이터 폴더로 다시 띄울 때. 설정 파일이 없을 때만 새로 쓰고, 나머지는 건드리지 않는다. */
  userDataDir?: string;
  /** 새 데이터 폴더일 때 마법사 완료 상태로 시작할지(기본 true). false 면 첫 실행처럼 마법사가 뜬다. */
  setupCompleted?: boolean;
  /** 실제 macOS 키체인을 쓴다(기본은 테스트 전용 암호화). */
  realKeychain?: boolean;
  /** 도구 정의를 바꾼다(가짜 도구 서버). QA_E2E_TOOLS_FILE 로 넘긴다. */
  toolsFile?: string;
  /** 앱에 더 넘길 테스트 환경 변수(예: QA_E2E_GITHUB_API) */
  env?: Record<string, string>;
}

/** 새 데이터 폴더에 넣는 설정. 스키마가 바뀌면 테스트가 먼저 깨져서 알 수 있다. */
function settingsJson(completed: boolean) {
  return {
    version: 1,
    evidence: { retentionDays: 30 },
    agent: { monthlyBudgetUsd: 100, judgeSampleRate: 0 },
    devices: { locale: "ko_KR" },
    policy: { evidenceUploadApproved: false },
    setup: { completedAt: completed ? "2026-10-21T00:00:00.000Z" : null },
  };
}

/**
 * 빌드된 앱(out/)을 격리된 데이터 폴더로 띄운다.
 * 기본은 테스트 전용 암호화(QA_E2E_TEST_CRYPTO=1)라 실제 macOS 키체인을 건드리지 않는다.
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "qa-e2e-userdata-"));
  mkdirSync(userDataDir, { recursive: true });
  if (!existsSync(join(userDataDir, "settings.json"))) {
    writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(settingsJson(options.setupCompleted ?? true)));
  }
  const env: Record<string, string> = { ...(process.env as Record<string, string>), QA_USER_DATA_DIR: userDataDir };
  if (!options.realKeychain) env["QA_E2E_TEST_CRYPTO"] = "1";
  if (options.toolsFile) env["QA_E2E_TOOLS_FILE"] = options.toolsFile;
  Object.assign(env, options.env ?? {});
  const app = await electron.launch({ args: [resolve(__dirname, "../out/main/index.js")], env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, userDataDir };
}
