import type { Build, Device } from "@qa/shared";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSecretResidue } from "@qa/evidence";
import { FAKE_ACCOUNT_ID, FAKE_ACCOUNT_PW, FAKE_SECRETS, fixtureDir, type FixtureName } from "../../../../../packages/evidence/src/test-fixtures";
import { AppDatabase } from "../db/database";
import type { LoggedProcessOptions, LoggedProcessResult, LoggedProcessRunner } from "../process/run-to-log";
import type { CommandRunner } from "../setup/command";
import { RunError, RunService, type RunServiceOptions } from "./run-service";

const UDID = "38D33774-E504-44EC-BE68-2E8FFB4E5D81";
const IOS: Device = { id: UDID, platform: "ios", kind: "simulator", name: "QA Tool iPhone 17", osVersion: "27.0", state: "booted", managed: true, serial: null, locale: "ko_KR" };
const BUILD: Build = {
  id: "build-1",
  app: "sample",
  target: "ios",
  appId: "com.apple.Preferences",
  version: "1.0",
  buildNumber: "7",
  commit: null,
  source: "file",
  path: "/builds/build-1/Settings.app",
  createdAt: "2026-10-21T00:00:00.000Z",
};

type Step = FixtureName | ((opts: LoggedProcessOptions) => Promise<LoggedProcessResult>);

/** maestro 대신 T-106 실제 산출물 픽스처를 출력 폴더로 복사한다 */
function fakeMaestro(queue: Step[]) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner: LoggedProcessRunner = async (file, opts) => {
    const args = [...(opts.args ?? [])];
    calls.push({ file, args, env: opts.env });
    const next = queue.shift();
    if (!next) throw new Error("픽스처 큐가 비었다");
    if (typeof next === "function") return next(opts);
    copyFixture(next, args, opts.logFile);
    const exitFile = join(fixtureDir(next), "exit-code");
    return { code: existsSync(exitFile) ? Number(readFileSync(exitFile, "utf8")) : 1, timedOut: false, canceled: false };
  };
  return { runner, calls };
}

function copyFixture(name: FixtureName, args: string[], logFile: string) {
  const outDir = args[args.indexOf("--test-output-dir") + 1] ?? "";
  const junit = args[args.indexOf("--output") + 1] ?? "";
  cpSync(join(fixtureDir(name), "maestro"), outDir, { recursive: true });
  if (existsSync(join(fixtureDir(name), "junit.xml"))) cpSync(join(fixtureDir(name), "junit.xml"), junit);
  appendFileSync(logFile, readFileSync(join(fixtureDir(name), "console.log")));
}

let dir: string;
let db: AppDatabase;
let flowPath: string;
let installs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-runs-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  db.db
    .prepare("INSERT INTO build (id, app, target, app_id, version, build_number, source, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(BUILD.id, BUILD.app, BUILD.target, BUILD.appId, BUILD.version, BUILD.buildNumber, BUILD.source, BUILD.path, BUILD.createdAt);
  mkdirSync(join(dir, "flows"));
  flowPath = join(dir, "flows", "TC-0002.yaml");
  writeFileSync(flowPath, "appId: ${APP_ID}\nname: TC-0002 설정 검색\ntags: [TC-0002, smoke]\n---\n- launchApp\n");
  installs = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const quietRun: CommandRunner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

let idCounter = 0;
function service(runner: LoggedProcessRunner, overrides: Partial<RunServiceOptions> = {}, devices: Device[] = [IOS]) {
  const s = new RunService({
    db,
    devices: { list: () => Promise.resolve({ devices }) },
    builds: {
      get: (id) => {
        if (id !== BUILD.id) throw new Error("no build");
        return BUILD;
      },
      install: (buildId, deviceId) => {
        installs.push(`${buildId}->${deviceId}`);
        return Promise.resolve({ installed: true });
      },
    },
    tools: { maestroBin: () => "/tools/maestro/bin/maestro", javaHome: () => "/tools/jre/Contents/Home" },
    accountSecrets: () => ({ QA_FIXTURE_ACCOUNT_ID: FAKE_ACCOUNT_ID, QA_FIXTURE_ACCOUNT_PW: FAKE_ACCOUNT_PW }),
    redactionSecrets: () => [...FAKE_SECRETS],
    evidenceRoot: join(dir, "evidence"),
    trustedFlowRoots: [join(dir, "workspaces")],
    home: "/Users/tester",
    androidHome: "/sdk",
    run: quietRun,
    runToLog: runner,
    loadAverage: () => 1.5,
    highLoad: 8,
    kill: () => undefined,
    newId: () => `id-${++idCounter}`,
    ...overrides,
  });
  s.allowFlow(flowPath);
  return s;
}

const startDefault = (s: RunService) => s.start({ app: "sample", flowPath, deviceId: UDID, buildId: BUILD.id });

describe("재생 실행", () => {
  it("통과: 빌드 설치 → maestro 실행 → 가린 사본 → 스텝 저장", async () => {
    const m = fakeMaestro(["ios-pass"]);
    const s = service(m.runner);
    const started = await startDefault(s);
    expect(started).toMatchObject({ status: "running", flowName: "TC-0002 설정 검색", tcId: "TC-0002", target: "ios", buildLabel: "com.apple.Preferences 1.0 (7)" });
    await s.wait(started.id);

    const run = s.get(started.id);
    expect(run).toMatchObject({ status: "passed", attempts: 1, flaky: false, failureMessage: null });
    expect(installs).toEqual([`build-1->${UDID}`]);
    const exec = run.executions[0];
    expect(exec).toMatchObject({ attempt: 1, status: "passed", failure: null, failureClass: null, hostLoad: 1.5 });
    expect(exec?.steps.map((x) => x.command)).toEqual(["launchAppCommand", "assertConditionCommand", "tapOnElement", "inputTextCommand", "takeScreenshotCommand"]);
    expect(exec?.steps[4]?.screenshot).toMatch(/^maestro\/.+\/takeScreenshot\/01_search_typed\.png$/);

    // maestro 호출: 기기, 출력 폴더, JUnit, -e (APP_ID 와 계정 값), 플로우. 환경은 앱의 JRE
    const call = m.calls[0];
    expect(call?.file).toBe("/tools/maestro/bin/maestro");
    expect(call?.args.slice(0, 3)).toEqual(["--device", UDID, "test"]);
    expect(call?.args).toEqual(expect.arrayContaining(["-e", "APP_ID=com.apple.Preferences", `QA_FIXTURE_ACCOUNT_ID=${FAKE_ACCOUNT_ID}`]));
    // 심볼릭 링크를 따라간 실경로로 넘긴다(허용 목록과 같은 기준)
    expect(call?.args.at(-1)).toBe(realpathSync(flowPath));
    expect(call?.env).toMatchObject({ JAVA_HOME: "/tools/jre/Contents/Home", MAESTRO_DRIVER_STARTUP_TIMEOUT: "90000", MAESTRO_CLI_NO_ANALYTICS: "true" });

    // 원본에는 값이 있고 가린 사본에는 없다. DB 의 스텝 설명·오류에도 없다
    const execDir = join(dir, "evidence", started.id, exec?.id ?? "");
    expect(findSecretResidue(join(execDir, "raw"), FAKE_SECRETS).length).toBeGreaterThan(0);
    expect(findSecretResidue(join(execDir, "redacted"), FAKE_SECRETS)).toEqual([]);
    expect(existsSync(join(execDir, "redacted", exec?.steps[4]?.screenshot ?? ""))).toBe(true);
    expect(readFileSync(join(execDir, "raw", "exit-code"), "utf8").trim()).toBe("0");
    expect(JSON.stringify(run)).not.toContain(FAKE_ACCOUNT_ID);
    expect(db.db.prepare("SELECT os, name FROM device WHERE id = ?").get(UDID)).toEqual({ os: "ios", name: "QA Tool iPhone 17" });
  });

  it("실패 뒤 재시도에서 통과하면 앞선 실패를 flaky 로 표시한다", async () => {
    const s = service(fakeMaestro(["ios-fail", "ios-pass"]).runner);
    const { id } = await startDefault(s);
    await s.wait(id);
    const run = s.get(id);
    expect(run).toMatchObject({ status: "passed", attempts: 2, flaky: true, failureMessage: null });
    expect(run.executions.map((e) => [e.attempt, e.status, e.failureClass, e.failure?.kind])).toEqual([
      [1, "failed", "flaky", "step_failed"],
      [2, "passed", null, undefined],
    ]);
  });

  it("두 번 모두 실패하면 failed. 실패 메시지의 값은 가려져 있다", async () => {
    const s = service(fakeMaestro(["ios-fail", "ios-fail"]).runner);
    const { id } = await startDefault(s);
    await s.wait(id);
    const run = s.get(id);
    expect(run).toMatchObject({ status: "failed", attempts: 2, flaky: false });
    expect(run.failureMessage).toBe("Element not found: Text matching regex: *** 없음");
    expect(run.executions[1]?.failure).toMatchObject({ kind: "step_failed", stepIndex: 5 });
    expect(run.executions[1]?.steps[5]?.failureScreenshot).toMatch(/screenshots\/step-008-/);
  });

  it("드라이버 시작 실패는 env_issue. 재시도에서 통과해도 env_issue 로 남긴다", async () => {
    const s = service(fakeMaestro(["ios-driver-timeout", "ios-pass"]).runner);
    const { id } = await startDefault(s);
    await s.wait(id);
    const run = s.get(id);
    expect(run).toMatchObject({ status: "passed", flaky: true });
    expect(run.executions[0]).toMatchObject({ status: "error", failureClass: "env_issue", failure: { kind: "driver_start" } });
  });

  it("높은 부하에서 시간 초과는 env_issue, 낮은 부하에서는 분류하지 않는다", async () => {
    const timeout = () => Promise.resolve({ code: -1, timedOut: true, canceled: false });
    const high = service(fakeMaestro([timeout, timeout]).runner, { loadAverage: () => 40, retries: 1 });
    const a = await startDefault(high);
    await high.wait(a.id);
    expect(high.get(a.id).executions.map((e) => [e.status, e.failure?.kind, e.failureClass])).toEqual([
      ["error", "interrupted", "env_issue"],
      ["error", "interrupted", "env_issue"],
    ]);
    const low = service(fakeMaestro([timeout]).runner, { retries: 0 });
    const b = await startDefault(low);
    await low.wait(b.id);
    expect(low.get(b.id).executions[0]).toMatchObject({ failureClass: null, failure: { kind: "interrupted" } });
  });

  it("취소하면 maestro 를 멈추고 다시 실행하지 않는다", async () => {
    const waitForAbort = (opts: LoggedProcessOptions) =>
      new Promise<LoggedProcessResult>((r) => opts.signal?.addEventListener("abort", () => r({ code: -1, timedOut: false, canceled: true })));
    const s = service(fakeMaestro([waitForAbort, "ios-pass"]).runner);
    const { id } = await startDefault(s);
    await new Promise((r) => setTimeout(r, 50));
    s.cancel(id);
    await s.wait(id);
    const run = s.get(id);
    expect(run).toMatchObject({ status: "canceled", attempts: 1 });
    expect(run.executions[0]?.failure?.kind).toBe("canceled");
    expect(() => s.cancel(id)).toThrow(RunError);
  });

  it("가린 사본에 값이 남으면(캡처 바이트 등) 결과를 쓰지 않고 다시 실행하지 않는다", async () => {
    const leaky = (opts: LoggedProcessOptions) => {
      copyFixture("ios-pass", [...(opts.args ?? [])], opts.logFile);
      const outDir = (opts.args ?? [])[(opts.args ?? []).indexOf("--test-output-dir") + 1] ?? "";
      const session = readdirSync(outDir)[0] ?? "";
      const flowDir = join(outDir, session, readdirSync(join(outDir, session)).find((n) => !n.endsWith(".log")) ?? "");
      appendFileSync(join(flowDir, "takeScreenshot", "01_search_typed.png"), FAKE_ACCOUNT_ID);
      return Promise.resolve({ code: 0, timedOut: false, canceled: false });
    };
    const s = service(fakeMaestro([leaky, "ios-pass"]).runner);
    const { id } = await startDefault(s);
    await s.wait(id);
    const run = s.get(id);
    expect(run).toMatchObject({ status: "error", attempts: 1 });
    expect(run.executions[0]).toMatchObject({ status: "error", steps: [], failure: { kind: "internal" } });
    expect(run.failureMessage).toMatch(/가린 사본에 비밀 값이 남았다/);
  });

  it("산출물을 해석하지 못하면 internal 오류로 남긴다(빈 스텝으로 통과시키지 않음)", async () => {
    const broken = (opts: LoggedProcessOptions) => {
      copyFixture("ios-pass", [...(opts.args ?? [])], opts.logFile);
      const outDir = (opts.args ?? [])[(opts.args ?? []).indexOf("--test-output-dir") + 1] ?? "";
      const session = readdirSync(outDir)[0] ?? "";
      const flowDir = join(outDir, session, readdirSync(join(outDir, session)).find((n) => !n.endsWith(".log")) ?? "");
      writeFileSync(join(flowDir, "commands.json"), "[{");
      return Promise.resolve({ code: 0, timedOut: false, canceled: false });
    };
    const s = service(fakeMaestro([broken]).runner);
    const { id } = await startDefault(s);
    await s.wait(id);
    expect(s.get(id)).toMatchObject({ status: "error", executions: [{ status: "error", failure: { kind: "internal" }, steps: [] }] });
  });
});

describe("실행 전 확인", () => {
  it("선택 창으로 고르지 않았거나 워크스페이스 밖의 플로우는 거부한다", async () => {
    const s = service(fakeMaestro([]).runner);
    const other = join(dir, "other.yaml");
    writeFileSync(other, "appId: a.b\n---\n- launchApp\n");
    await expect(s.start({ app: "sample", flowPath: other, deviceId: UDID, buildId: null })).rejects.toThrow(/선택 창으로 고르거나 워크스페이스/);
    await expect(s.start({ app: "sample", flowPath: "relative.yaml", deviceId: UDID, buildId: null })).rejects.toThrow(/플로우 파일이 없다/);
    // 워크스페이스 안은 고르지 않아도 된다
    mkdirSync(join(dir, "workspaces", "ws", "flows"), { recursive: true });
    const inWs = join(dir, "workspaces", "ws", "flows", "TC-0003.yaml");
    writeFileSync(inWs, "appId: com.apple.Preferences\n---\n- launchApp\n");
    const s2 = service(fakeMaestro(["ios-pass"]).runner);
    const r = await s2.start({ app: "sample", flowPath: inWs, deviceId: UDID, buildId: null });
    await s2.wait(r.id);
    expect(s2.summary(r.id).status).toBe("passed");
    expect(installs).toEqual([]);
  });

  it("꺼진 기기, 다른 플랫폼 빌드, appId 불일치, 변수 appId 인데 빌드 없음, 도구 미설치를 거부한다", async () => {
    const off = service(fakeMaestro([]).runner, {}, [{ ...IOS, state: "shutdown" }]);
    await expect(startDefault(off)).rejects.toThrow(/실행 중이 아니다/);
    const android = service(fakeMaestro([]).runner, {}, [{ ...IOS, platform: "android", serial: "emulator-5554" }]);
    await expect(startDefault(android)).rejects.toThrow(/ios 빌드를 android 기기에서/);
    const s = service(fakeMaestro([]).runner);
    await expect(s.start({ app: "sample", flowPath, deviceId: UDID, buildId: null })).rejects.toThrow(/빌드를 골라야/);
    await expect(s.start({ app: "other", flowPath, deviceId: UDID, buildId: BUILD.id })).rejects.toThrow(/앱\(sample\)과 실행할 앱\(other\)/);
    writeFileSync(flowPath, "appId: net.other.app\n---\n- launchApp\n");
    await expect(startDefault(s)).rejects.toThrow(/appId\(net\.other\.app\)와 빌드/);
    const noTools = service(fakeMaestro([]).runner, { tools: { maestroBin: () => null, javaHome: () => null } });
    writeFileSync(flowPath, "appId: ${APP_ID}\n---\n- launchApp\n");
    await expect(startDefault(noTools)).rejects.toThrow(/설치되지 않았다/);
  });

  it("플로우 만들기 재생(main 전용 옵션): 빌드 없이 앱 id 를 넣고, 계정 값은 TC 역할 키로만 넘기고, trigger 를 남긴다", async () => {
    const m = fakeMaestro(["ios-pass"]);
    const s = service(m.runner);
    const started = await s.start({ app: "sample", flowPath, deviceId: UDID, buildId: null }, { appId: "com.example.demo", envKeys: ["QA_FIXTURE_ACCOUNT_ID"], trigger: "author" });
    await s.wait(started.id);
    const args = m.calls[0]?.args ?? [];
    expect(args).toEqual(expect.arrayContaining(["-e", "APP_ID=com.example.demo", `QA_FIXTURE_ACCOUNT_ID=${FAKE_ACCOUNT_ID}`]));
    expect(args.some((a) => a.startsWith("QA_FIXTURE_ACCOUNT_PW="))).toBe(false);
    expect((db.db.prepare("SELECT trigger FROM run WHERE id = ?").get(started.id) as { trigger: string }).trigger).toBe("author");
  });

  it("같은 기기에서 동시에 두 실행을 하지 않는다", async () => {
    let release: () => void = () => undefined;
    const gate = (opts: LoggedProcessOptions) =>
      new Promise<LoggedProcessResult>((r) => {
        release = () => {
          copyFixture("ios-pass", [...(opts.args ?? [])], opts.logFile);
          r({ code: 0, timedOut: false, canceled: false });
        };
      });
    const s = service(fakeMaestro([gate]).runner);
    const first = await startDefault(s);
    await expect(startDefault(s)).rejects.toThrow(/이미 실행 중/);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await s.wait(first.id);
    expect(s.summary(first.id).status).toBe("passed");
  });

  it("앱이 꺼져 남은 실행 중 기록은 다음 시작 때 중단으로 바꾼다", () => {
    const summary = { app: "sample", flowName: "x", flowPath, tcId: "adhoc", target: "ios", deviceId: UDID, deviceName: "d", buildId: null, buildLabel: null, attempts: 1, flaky: false, failureMessage: null };
    db.db.prepare("INSERT INTO run (id, workspace, trigger, status, summary, created_at) VALUES ('r1', 'local', 'manual', 'running', ?, '2026-10-21T00:00:00.000Z')").run(JSON.stringify(summary));
    db.db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status) VALUES ('e1', 'r1', 'adhoc', 'ios', ?, 'running')").run(flowPath);
    const s = service(fakeMaestro([]).runner);
    expect(s.get("r1")).toMatchObject({ status: "error", failureMessage: "앱이 종료돼 실행이 중단됐다", executions: [{ status: "error", failure: { kind: "interrupted" } }] });
  });
});

describe("재생 경로에는 LLM 이 없다 (PLAN 7.9)", () => {
  it("실행·프로세스·증적 코드가 에이전트나 Anthropic SDK 를 가져오지 않는다", () => {
    const roots = [__dirname, resolve(__dirname, "../process"), resolve(__dirname, "../../../../../packages/evidence/src")];
    const files = roots.flatMap((r) => readdirSync(r).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(r, f)));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const banned of ["@anthropic-ai", "@qa/agent", "anthropic.com", "../agent", "AgentService"]) {
        expect(text.includes(banned), `${f} 에 ${banned}`).toBe(false);
      }
    }
    expect(dirname(__dirname).endsWith("main")).toBe(true);
  });
});
