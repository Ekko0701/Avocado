import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoggedProcessRunner } from "../process/run-to-log";
import type { CommandResult, CommandRunner } from "../setup/command";
import { AgentDevice, AgentDeviceError, parseJsonFailure, runnerFailureHint } from "./agent-device";

const UDID = "00008160-001C79811EA80036";
const TEAM = "TEAMAAAA11";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-device-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function make(results: Partial<Record<string, CommandResult[]>> = {}, onRun?: (args: readonly string[]) => void) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const run: CommandRunner = (file, args, options) => {
    calls.push({ file, args: [...args], env: options?.env });
    onRun?.(args);
    const queue = results[args[1] ?? ""] ?? [];
    return Promise.resolve(queue.shift() ?? { code: 0, stdout: "", stderr: "" });
  };
  const logged: Parameters<LoggedProcessRunner>[] = [];
  const runToLog: LoggedProcessRunner = (file, opts) => {
    logged.push([file, opts]);
    return Promise.resolve({ code: 0, timedOut: false, canceled: false });
  };
  const ad = new AgentDevice({ entry: () => "/tools/agent-device/package/bin/agent-device.mjs", nodeBin: "/Applications/Avocado.app/Contents/MacOS/Avocado", root, home: "/Users/tester", run, runToLog });
  return { ad, calls, logged };
}

describe("AgentDevice", () => {
  it("환경: Electron 을 Node 로, 상태·빌드 폴더는 앱 데이터 안, 업데이트 확인 끔, 사용자 PATH 없음", () => {
    const env = make().ad.env(TEAM);
    expect(env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      AGENT_DEVICE_HOME: join(root, "home"),
      AGENT_DEVICE_STATE_DIR: join(root, "state"),
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: join(root, `derived-${TEAM}`),
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      AGENT_DEVICE_IOS_TEAM_ID: TEAM,
      AGENT_DEVICE_IOS_BUNDLE_ID: "dev.avocado.agentdevice.teamaaaa11.runner",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
  });

  it("도구가 없으면 설치하라고 알린다", () => {
    const ad = new AgentDevice({ entry: () => null, nodeBin: "/x", root, home: "/h", run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }), runToLog: () => Promise.resolve({ code: 0, timedOut: false, canceled: false }) });
    expect(() => ad.entry()).toThrow(/설치되지 않았다/);
  });

  it("test: 인자 배열로 --maestro 재생하고 -e 를 넘긴 뒤 데몬을 내린다", async () => {
    const { ad, logged, calls } = make();
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "daemon.json"), "{}");
    const abort = new AbortController();
    await ad.test({ udid: UDID, teamId: TEAM, flowPath: "/runs/flow/TC-1.yaml", env: { APP_ID: "com.example.demo", DEMO_PW: "pw value" }, artifactsDir: "/runs/raw/agent-device", logFile: "/runs/raw/console.log", cwd: "/runs/flow", timeoutMs: 60_000, signal: abort.signal });
    const [file, opts] = logged[0] ?? [];
    expect(file).toBe("/Applications/Avocado.app/Contents/MacOS/Avocado");
    expect(opts?.args).toEqual([
      "/tools/agent-device/package/bin/agent-device.mjs",
      "test",
      "/runs/flow/TC-1.yaml",
      "--maestro",
      "--platform",
      "ios",
      "--udid",
      UDID,
      "--artifacts-dir",
      "/runs/raw/agent-device",
      "--timeout",
      "60000",
      "-e",
      "APP_ID=com.example.demo",
      "-e",
      "DEMO_PW=pw value",
    ]);
    expect(calls.map((c) => c.args.slice(1, 3))).toEqual([["daemon", "stop"]]);
    expect(calls[0]?.args).toContain(join(root, "state"));
  });

  it("데몬 기록이 없으면 내리지 않는다", async () => {
    const { ad, calls } = make();
    await ad.stopDaemon(TEAM);
    expect(calls).toEqual([]);
  });

  it("prepareRunner: 성공하면 데몬만 내린다", async () => {
    const { ad, calls } = make({}, (args) => {
      if (args[1] === "prepare") {
        mkdirSync(join(root, "state"), { recursive: true });
        writeFileSync(join(root, "state", "daemon.json"), "{}");
      }
    });
    await ad.prepareRunner(UDID, TEAM);
    expect(calls.map((c) => c.args[1])).toEqual(["prepare", "daemon"]);
    expect(calls[0]?.args).toEqual(["/tools/agent-device/package/bin/agent-device.mjs", "prepare", "ios-runner", "--platform", "ios", "--udid", UDID, "--timeout", "900000", "--json"]);
  });

  it("prepareRunner: 프로파일에 기기가 없어 설치가 거부되면 빌드 폴더를 비우고 한 번 더 한다", async () => {
    const derived = join(root, `derived-${TEAM}`);
    const fail = { code: 1, stdout: JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "runner failed" } }), stderr: "" };
    const { ad, calls } = make({ prepare: [fail, { code: 0, stdout: "", stderr: "" }] }, (args) => {
      if (args[1] !== "prepare") return;
      mkdirSync(derived, { recursive: true });
      mkdirSync(join(root, "state", "sessions", "s1"), { recursive: true });
      writeFileSync(join(root, "state", "sessions", "s1", "runner.log"), "Failed to install embedded profile : 0xe8008012 (This provisioning profile cannot be installed on this device.)");
    });
    await ad.prepareRunner(UDID, TEAM);
    expect(calls.filter((c) => c.args[1] === "prepare")).toHaveLength(2);
  });

  it("prepareRunner: 서명 실패는 원인과 할 일을 담아 던진다", async () => {
    const fail = { code: 1, stdout: JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "signing failed", details: { reason: "signing_no_development_team" } } }), stderr: "" };
    const { ad } = make({ prepare: [fail] });
    const error = await ad.prepareRunner(UDID, TEAM).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentDeviceError);
    expect((error as AgentDeviceError).reason).toBe("signing_no_development_team");
    expect((error as Error).message).toMatch(/Xcode → 설정 → 계정/);
  });
});

describe("parseJsonFailure·runnerFailureHint", () => {
  it("--json 실패 응답만 읽는다", () => {
    expect(parseJsonFailure('note\n{"success":false,"error":{"code":"X","message":"m","details":{"reason":"r"}}}')).toEqual({ message: "m", reason: "r" });
    expect(parseJsonFailure('{"success":true}')).toBeNull();
    expect(parseJsonFailure("no json")).toBeNull();
  });

  it("Mac 보안 설정·기기 개발자 모드는 할 일을 알려 준다", () => {
    expect(runnerFailureHint("devtools_security_developer_mode_disabled", "")).toMatch(/sudo DevToolsSecurity -enable/);
    expect(runnerFailureHint("device_developer_mode_disabled", "")).toMatch(/개발자 모드/);
    expect(runnerFailureHint(null, "Runner did not accept connection (Timed out while enabling automation mode)")).toMatch(/UI 자동화/);
    expect(runnerFailureHint(null, "something else")).toBe("something else");
  });
});
