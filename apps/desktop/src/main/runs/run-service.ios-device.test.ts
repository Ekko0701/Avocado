import type { Build, Device } from "@qa/shared";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSecretResidue } from "@qa/evidence";
import { AppDatabase } from "../db/database";
import { AgentDevice } from "../devices/agent-device";
import type { LoggedProcessOptions, LoggedProcessResult, LoggedProcessRunner } from "../process/run-to-log";
import type { CommandRunner } from "../setup/command";
import { RunService, type IosDeviceRunSupport } from "./run-service";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "..", "packages", "evidence", "fixtures");
const FAKE = "fixture-account-7731";
const UDID = "00008160-001C79811EA80036";
const TEAM = "TEAMAAAA11";
const PHONE: Device = { id: UDID, platform: "ios", kind: "real", name: "테스트 iPhone", osVersion: "27.0.1", state: "booted", managed: false, serial: null, locale: null };
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
  label: null,
};

let dir: string;
let db: AppDatabase;
let flowPath: string;
let installs: string[];
let screenshots: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-runs-device-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  db.db
    .prepare("INSERT INTO build (id, app, target, app_id, version, build_number, source, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(BUILD.id, BUILD.app, BUILD.target, BUILD.appId, BUILD.version, BUILD.buildNumber, BUILD.source, BUILD.path, BUILD.createdAt);
  mkdirSync(join(dir, "flows", "common"), { recursive: true });
  flowPath = join(dir, "flows", "TC-0002.yaml");
  writeFileSync(flowPath, "appId: ${APP_ID}\nname: TC-0002 설정 검색\ntags: [TC-0002]\n---\n- launchApp\n- inputText: ${QA_FIXTURE_ACCOUNT_ID}\n- takeScreenshot: 01_search_typed\n");
  installs = [];
  screenshots = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** agent-device test 대신 실제 iPhone 산출물 픽스처를 --artifacts-dir 로 복사한다 */
function fakeAgentDevice(queue: ("ios-device-pass" | "ios-device-fail")[]) {
  const calls: LoggedProcessOptions[] = [];
  const runToLog: LoggedProcessRunner = (_file, opts): Promise<LoggedProcessResult> => {
    calls.push(opts);
    const name = queue.shift();
    if (!name) throw new Error("픽스처 큐가 비었다");
    const args = [...(opts.args ?? [])];
    const artifacts = args[args.indexOf("--artifacts-dir") + 1] ?? "";
    cpSync(join(FIXTURES, name, "agent-device"), artifacts, { recursive: true });
    if (existsSync(join(FIXTURES, name, "console.log"))) appendFileSync(opts.logFile, readFileSync(join(FIXTURES, name, "console.log")));
    return Promise.resolve({ code: Number(readFileSync(join(FIXTURES, name, "exit-code"), "utf8")), timedOut: false, canceled: false });
  };
  const run: CommandRunner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
  const agentDevice = new AgentDevice({ entry: () => "/tools/agent-device.mjs", nodeBin: "/app/Avocado", root: join(dir, "agent-device"), home: "/Users/tester", run, runToLog });
  return { agentDevice, calls };
}

function support(agentDevice: AgentDevice, overrides: Partial<IosDeviceRunSupport> = {}): IosDeviceRunSupport {
  return {
    agentDevice,
    signingTeam: () => TEAM,
    check: () => Promise.resolve({ ready: true, checks: [{ label: "연결", ok: true, detail: "" }] }),
    isAppInstalled: () => Promise.resolve(true),
    screenshot: (_id, dest) => {
      screenshots.push(dest);
      cpSync(join(FIXTURES, "ios-device-fail", "failure.png"), dest);
      return Promise.resolve();
    },
    ...overrides,
  };
}

let idCounter = 0;
function service(ios: IosDeviceRunSupport | undefined, maestroRunner?: LoggedProcessRunner, retries = 0) {
  const s = new RunService({
    db,
    devices: { list: () => Promise.resolve({ devices: [PHONE], androidAvailable: false }) },
    builds: {
      get: () => BUILD,
      install: (buildId, deviceId) => {
        installs.push(`${buildId}->${deviceId}`);
        return Promise.resolve({ installed: true });
      },
    },
    // Maestro 가 없어도 iPhone 은 돈다
    tools: { maestroBin: () => null, javaHome: () => null },
    accountSecrets: () => ({ QA_FIXTURE_ACCOUNT_ID: FAKE }),
    accountKeys: () => ["QA_FIXTURE_ACCOUNT_ID"],
    redactionSecrets: () => [FAKE],
    evidenceRoot: join(dir, "evidence"),
    trustedFlowRoots: [],
    home: "/Users/tester",
    androidHome: "/sdk",
    run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    runToLog:
      maestroRunner ??
      (() => {
        throw new Error("Maestro 를 부르면 안 된다");
      }),
    retries,
    newId: () => `id-${++idCounter}`,
    ...(ios ? { iosDevice: ios } : {}),
  });
  s.allowFlow(flowPath);
  return s;
}

const start = (s: RunService) => s.start({ app: "sample", flowPath, deviceId: UDID, buildId: BUILD.id });

describe("iOS 실기기 재생(agent-device)", () => {
  it("통과: 설치하지 않고 실행용 사본으로 재생한다 → 가린 사본 → 스텝 저장", async () => {
    const ad = fakeAgentDevice(["ios-device-pass"]);
    const s = service(support(ad.agentDevice));
    const run = await start(s);
    await s.wait(run.id);
    const detail = s.get(run.id);
    expect(detail.status).toBe("passed");
    expect(installs).toEqual([]);
    const exec = detail.executions[0];
    expect(exec?.steps.map((st) => st.command)).toEqual(["launchApp", "extendedWaitUntil", "tapOn", "inputText", "takeScreenshot"]);
    expect(exec?.steps[4]?.screenshot).toMatch(/^agent-device\/.*01_search_typed\.png$/);
    expect(exec?.warnings).toEqual([]);
    // 실행용 사본은 증적 밖(<실행 폴더>/flow)에 두고, 캡처 이름에 .png 를 붙였다
    const args = [...(ad.calls[0]?.args ?? [])];
    const flowCopy = args[args.indexOf("test") + 1] ?? "";
    expect(flowCopy).toMatch(/evidence\/.+\/flow\/TC-0002\.yaml$/);
    expect(readFileSync(flowCopy, "utf8")).toContain("takeScreenshot: 01_search_typed.png");
    expect(args).toEqual(expect.arrayContaining(["--udid", UDID, "-e", "APP_ID=com.apple.Preferences", "-e", `QA_FIXTURE_ACCOUNT_ID=${FAKE}`]));
    expect(screenshots).toEqual([]);
  });

  it("실패: 실패 화면을 찍어 실패 스텝에 잇고, 선택자에 들어간 값은 가린다", async () => {
    const ad = fakeAgentDevice(["ios-device-fail"]);
    const s = service(support(ad.agentDevice));
    const run = await start(s);
    await s.wait(run.id);
    const detail = s.get(run.id);
    expect(detail.status).toBe("failed");
    const failed = detail.executions[0]?.steps.find((st) => st.status === "failed");
    expect(failed?.failureScreenshot).toBe("failure.png");
    expect(screenshots).toHaveLength(1);
    expect(detail.failureMessage).not.toContain(FAKE);
    expect(findSecretResidue(join(dir, "evidence", run.id), [FAKE]).filter((r) => r.path.includes("redacted"))).toEqual([]);
  });

  it("준비 점검이 실패하면 기기에 손대지 않고 거부한다", async () => {
    const ad = fakeAgentDevice([]);
    const s = service(support(ad.agentDevice, { check: () => Promise.resolve({ ready: false, checks: [{ label: "잠금 해제", ok: false, detail: "iPhone 잠금을 풀어 둔다" }] }) }));
    await expect(start(s)).rejects.toThrow(/iPhone 이 준비되지 않았다: 잠금 해제 — iPhone 잠금을 풀어 둔다/);
    expect(ad.calls).toEqual([]);
  });

  it("앱이 설치돼 있지 않으면 거부한다(빌드는 설치하지 않는다)", async () => {
    const ad = fakeAgentDevice([]);
    const s = service(support(ad.agentDevice, { isAppInstalled: () => Promise.resolve(false) }));
    await expect(start(s)).rejects.toThrow(/com.apple.Preferences 앱이 설치돼 있지 않다/);
    expect(installs).toEqual([]);
  });

  it("실기기에서 못 쓰는 명령이 있으면 시작하기 전에 거부한다", async () => {
    writeFileSync(flowPath, "appId: ${APP_ID}\nname: TC-0002\n---\n- launchApp:\n    clearState: true\n");
    const ad = fakeAgentDevice([]);
    const s = service(support(ad.agentDevice));
    await expect(start(s)).rejects.toThrow(/iOS 실기기에서 재생할 수 없는 명령이 있다: TC-0002.yaml:4 launchApp.clearState/);
    expect(ad.calls).toEqual([]);
  });

  it("재시도 전에 잠기면 기기 오류 대신 할 일로 끝난다", async () => {
    const ad = fakeAgentDevice(["ios-device-fail"]);
    let checks = 0;
    const s = service(
      support(ad.agentDevice, {
        check: () => {
          checks += 1;
          // 시작 점검·1회차는 통과, 2회차 전에 잠김
          return Promise.resolve(checks <= 2 ? { ready: true, checks: [] } : { ready: false, checks: [{ label: "잠금 해제", ok: false, detail: "iPhone 잠금을 풀어 둔다" }] });
        },
      }),
      undefined,
      1,
    );
    const run = await start(s);
    await s.wait(run.id);
    const detail = s.get(run.id);
    expect(detail.executions.map((e) => e.status)).toEqual(["failed", "error"]);
    expect(detail.failureMessage).toBe("iPhone 이 준비되지 않았다: 잠금 해제 — iPhone 잠금을 풀어 둔다");
    expect(ad.calls).toHaveLength(1);
  });

  it("iOS 실기기 지원이 없으면 거부한다", async () => {
    await expect(start(service(undefined))).rejects.toThrow(/iOS 실기기 실행을 쓸 수 없다/);
  });
});
