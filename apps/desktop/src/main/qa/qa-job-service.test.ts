import type { Device, RunDetail, RunSummary, StartRunInput } from "@qa/shared";
import type { CommandRunner } from "../setup/command";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaJobService } from "./qa-job-service";
import { QaJobStore } from "./qa-job-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-jobs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TABLET: Device = { id: "R58M123", platform: "android", kind: "real", name: "SM-P610", osVersion: "13", state: "booted", managed: false, serial: "R58M123", locale: null };
const AT = "2026-11-10T06:00:00.000Z";
const FLOW = "appId: net.example.app\n---\n- tapOn: \"강좌함\"\n";
const conn = { id: "c1", client: "claude-code 1.0" };

function summary(input: StartRunInput, status: RunSummary["status"]): RunSummary {
  return {
    id: "run-1",
    status,
    app: input.app,
    flowName: "after-1",
    flowPath: input.flowPath,
    tcId: "adhoc",
    target: "android",
    deviceId: input.deviceId,
    deviceName: "SM-P610",
    buildId: null,
    buildLabel: null,
    attempts: 1,
    flaky: false,
    failureMessage: status === "failed" ? "\"강좌함\" 을 찾지 못했다" : null,
    kept: false,
    evidenceRemoved: false,
    createdAt: AT,
    startedAt: AT,
    finishedAt: AT,
  };
}

const SPEC = "## 기대값\n- 강좌함 탭을 누르면 수강 강좌 목록이 보인다";
const ANALYSIS = "## 원인\n- 탭 클릭 처리에서 화면 전환이 빠져 있었다";
const VERDICT = "## 판정\n- 수정 후 캡처에서 수강 강좌 목록이 보인다. 기대값과 일치";

function setup(result: RunSummary["status"] = "passed", opts: { flaky?: boolean; crash?: boolean } = {}) {
  const started: StartRunInput[] = [];
  const adbCalls: string[] = [];
  const run: CommandRunner = async (_file, args) => {
    const cmd = args.join(" ");
    adbCalls.push(cmd);
    if (cmd.includes("shell date")) return { code: 0, stdout: "11-10 15:00:00.000\n", stderr: "" };
    if (cmd.includes("shell pidof")) return { code: 0, stdout: "5739\n", stderr: "" };
    if (cmd.includes("-b crash")) return { code: 0, stdout: opts.crash ? "FATAL EXCEPTION: main\n" : "", stderr: "" };
    if (cmd.includes("logcat")) return { code: 0, stdout: "I/App: token=SECRET-VALUE loaded\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "not mocked" };
  };
  const canceled: string[] = [];
  let last: StartRunInput | null = null;
  const service = new QaJobService({
    store: new QaJobStore(join(dir, "jobs.json")),
    devices: { list: async () => ({ devices: [TABLET, { ...TABLET, id: "qa_pixel", kind: "emulator", name: "qa_pixel", state: "shutdown", serial: null }] }) },
    runs: {
      start: async (input) => {
        started.push(input);
        last = input;
        return summary(input, "queued");
      },
      wait: async () => undefined,
      cancel: (runId) => {
        canceled.push(runId);
        return summary(last as StartRunInput, "canceled");
      },
      get: (): RunDetail => ({
        ...summary(last as StartRunInput, result),
        flaky: opts.flaky ?? false,
        executions: [
          {
            id: "exec-1",
            attempt: 1,
            status: result === "passed" ? "passed" : "failed",
            durationMs: 1000,
            failureClass: null,
            failure: null,
            hostLoad: 1,
            startedAt: AT,
            finishedAt: AT,
            warnings: [],
            steps: [{ index: 0, command: "tapOn", description: "Tap on \"강좌함\"", status: result === "passed" ? "completed" : "failed", durationMs: 500, error: result === "passed" ? null : "Element not found", screenshot: null, failureScreenshot: result === "passed" ? null : "maestro/fail.png", hierarchy: null }],
          },
        ],
      }),
    },
    flowsDir: join(dir, "flows"),
    evidenceRoot: join(dir, "evidence"),
    logsDir: join(dir, "logs"),
    adb: "/sdk/platform-tools/adb",
    run,
    redact: (text) => text.replaceAll("SECRET-VALUE", "***"),
    now: () => new Date(AT),
    newId: () => "job-1",
  });
  const call = async (name: string, args: unknown) => {
    const r = await service.mcpCall(conn, name, args);
    const first = r.content[0];
    return { text: first?.type === "text" ? first.text : "", isError: r.isError === true };
  };
  /** 기대값·원인까지 남긴 작업을 만든다 */
  const prepared = async () => {
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "spec", content: SPEC });
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "analysis", content: ANALYSIS });
  };
  return { service, call, started, canceled, adbCalls, prepared };
}

describe("QA 수정 작업 도구", () => {
  it("작업을 시작하고 단계 보고를 차례로 적는다", async () => {
    const { service, call } = setup();
    expect((await call("qa_job_start", { ticket: "QA/567", title: "설정 화면 버튼 이동", url: "https://example.dooray.com/task/1" })).text).toContain("jobId: job-1");
    await call("qa_job_report", { jobId: "job-1", stage: "analysis", message: "원인은 버튼 클릭 처리에서 주소가 빠진 것" });
    await call("qa_job_report", { jobId: "job-1", stage: "received", message: "재현에 결제 계정이 필요해 멈춘다", status: "stopped", branch: "1.2.0/qa/fix/567" });
    const job = service.list()[0];
    expect(job).toMatchObject({ ticket: "QA/567", stage: "received", status: "stopped", branch: "1.2.0/qa/fix/567", verification: "not_run" });
    expect(job?.events.map((e) => e.stage)).toEqual(["received", "analysis", "received"]);
  });

  it("같은 티켓의 진행 중인 작업이 있으면 새로 만들지 않고 이어 쓴다", async () => {
    const { service, call } = setup();
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    expect((await call("qa_job_start", { ticket: "QA/567", title: "제목" })).text).toContain("이어 쓴다");
    expect(service.list()).toHaveLength(1);
  });

  it("기록은 파일에 남아 앱을 다시 켜도 보인다", async () => {
    const { call } = setup();
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    expect(new QaJobStore(join(dir, "jobs.json")).list().map((j) => j.ticket)).toEqual(["QA/567"]);
  });

  it("기록 파일이 깨졌으면 조용히 비우지 않고 오류를 낸다", () => {
    writeFileSync(join(dir, "jobs.json"), "{ 깨진 파일");
    expect(() => new QaJobStore(join(dir, "jobs.json"))).toThrow();
  });

  it("쓸 수 있는 기기만 알려 준다(꺼진 에뮬레이터 제외)", async () => {
    const { call } = setup();
    const text = (await call("qa_job_devices", {})).text;
    expect(text).toContain("R58M123");
    expect(text).toContain("실기기");
    expect(text).not.toContain("qa_pixel");
  });

  it("플로우를 적어 두고 재생한 뒤 스텝 결과와 증적 폴더를 돌려준다", async () => {
    const { service, call, started, prepared } = setup("passed");
    await prepared();
    const r = await call("qa_job_run_flow", { jobId: "job-1", label: "after", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("결과: passed");
    expect(r.text).toContain(join(dir, "evidence", "run-1", "exec-1", "redacted"));
    expect(started[0]).toMatchObject({ app: "demo", deviceId: "R58M123", buildId: null });
    expect(readFileSync(started[0]?.flowPath ?? "", "utf8")).toBe(FLOW);
    expect(started[0]?.flowPath.startsWith(join(dir, "flows", "job-1"))).toBe(true);
    expect(service.list()[0]?.runs).toEqual([{ runId: "run-1", label: "after", deviceName: "SM-P610", status: "passed", flaky: false, logPath: join(dir, "logs", "run-1.log"), at: AT }]);
  });

  it("실패한 재생은 실패 이유와 실패 캡처 위치를 알려 준다", async () => {
    const { call, prepared } = setup("failed");
    await prepared();
    const r = await call("qa_job_run_flow", { jobId: "job-1", label: "before", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    expect(r.text).toContain("결과: failed");
    expect(r.text).toContain("실패 이유");
    expect(r.text).toContain("maestro/fail.png");
  });

  it("기기의 앱 데이터를 지우는 명령이 있으면 실행하지 않는다", async () => {
    const { call, started } = setup();
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    const r = await call("qa_job_run_flow", { jobId: "job-1", label: "check", deviceId: "R58M123", app: "demo", flowYaml: "appId: net.example.app\n---\n- launchApp:\n    clearState: true\n" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("clearState");
    expect(started).toHaveLength(0);
  });

  it("없는 작업이나 형식이 틀린 입력은 오류로 알린다", async () => {
    const { call } = setup();
    expect((await call("qa_job_report", { jobId: "none", stage: "fix", message: "x" })).isError).toBe(true);
    expect((await call("qa_job_report", { jobId: "none", stage: "없는단계", message: "x" })).isError).toBe(true);
  });

  it("기대값을 남기기 전에는 수정 전·후 실행을 돌리지 않는다(그 밖의 확인은 된다)", async () => {
    const { call, started } = setup();
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    const r = await call("qa_job_run_flow", { jobId: "job-1", label: "before", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("spec");
    expect(started).toHaveLength(0);
    expect((await call("qa_job_run_flow", { jobId: "job-1", label: "check", deviceId: "R58M123", app: "demo", flowYaml: FLOW })).isError).toBe(false);
  });

  it("기대값과 원인을 남기지 않으면 수정 단계 보고를 받지 않는다", async () => {
    const { call } = setup();
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    const r = await call("qa_job_report", { jobId: "job-1", stage: "fix", message: "고쳤다" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("spec");
    expect(r.text).toContain("analysis");
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "spec", content: SPEC });
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "analysis", content: ANALYSIS });
    expect((await call("qa_job_report", { jobId: "job-1", stage: "fix", message: "고쳤다" })).isError).toBe(false);
  });

  it("같은 종류의 근거를 다시 내면 앞의 것을 바꾼다", async () => {
    const { service, call, prepared } = setup();
    await prepared();
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "spec", content: `${SPEC}\n- 뒤로 가면 홈이 보인다` });
    const specs = service.list()[0]?.artifacts.filter((a) => a.kind === "spec") ?? [];
    expect(specs).toHaveLength(1);
    expect(specs[0]?.content).toContain("뒤로 가면 홈이 보인다");
  });

  it("수정 후 실행이 통과하지 않았으면 verified 로 끝낼 수 없다", async () => {
    const { call, prepared } = setup("failed");
    await prepared();
    await call("qa_job_run_flow", { jobId: "job-1", label: "after", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "verdict", content: VERDICT });
    const r = await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR 을 올렸다", status: "succeeded", verification: "verified" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("after");
  });

  it("판정을 남기지 않았거나 기기 확인을 못 한 이유가 없으면 성공으로 끝낼 수 없다", async () => {
    const { call, prepared } = setup();
    await prepared();
    expect((await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR", status: "succeeded", verification: "not_run", verificationNote: "기기 없음" })).text).toContain("verdict");
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "verdict", content: VERDICT });
    expect((await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR", status: "succeeded", verification: "not_run" })).text).toContain("이유");
    expect((await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR", status: "succeeded", verification: "not_run", verificationNote: "재현에 결제 계정이 필요하다" })).isError).toBe(false);
  });

  it("통과한 수정 후 실행과 판정이 있으면 verified 로 끝난다", async () => {
    const { service, call, prepared } = setup("passed");
    await prepared();
    await call("qa_job_run_flow", { jobId: "job-1", label: "after", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "verdict", content: VERDICT });
    const r = await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR 을 올렸다", status: "succeeded", verification: "verified", mrUrl: "https://git.example.com/mr/1" });
    expect(r.isError).toBe(false);
    expect(service.list()[0]).toMatchObject({ status: "succeeded", verification: "verified", mrUrl: "https://git.example.com/mr/1" });
  });

  it("첫 시도에 실패하고 다시 돌려 통과했으면 verified_after_retry 로만 끝낼 수 있다", async () => {
    const { call, prepared } = setup("passed", { flaky: true });
    await prepared();
    await call("qa_job_run_flow", { jobId: "job-1", label: "after", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    await call("qa_job_save_artifact", { jobId: "job-1", kind: "verdict", content: VERDICT });
    expect((await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR", status: "succeeded", verification: "verified" })).text).toContain("verified_after_retry");
    expect((await call("qa_job_report", { jobId: "job-1", stage: "mr", message: "MR", status: "succeeded", verification: "verified_after_retry" })).isError).toBe(false);
  });

  it("실행 동안의 앱 로그를 그 앱 프로세스로 좁혀 모으고, 비밀 값을 가려 적는다", async () => {
    const { call, adbCalls } = setup("passed", { crash: true });
    await call("qa_job_start", { ticket: "QA/567", title: "제목" });
    const r = await call("qa_job_run_flow", { jobId: "job-1", label: "check", deviceId: "R58M123", app: "demo", flowYaml: FLOW });
    expect(adbCalls).toContain("-s R58M123 shell pidof net.example.app");
    expect(adbCalls).toContain("-s R58M123 shell date '+%m-%d %H:%M:%S.000'");
    expect(adbCalls).toContain("-s R58M123 shell logcat -d -v threadtime -t '11-10 15:00:00.000' --pid=5739");
    expect(adbCalls.some((c) => c.includes("logcat -c"))).toBe(false);
    const log = readFileSync(join(dir, "logs", "run-1.log"), "utf8");
    expect(log).toContain("token=*** loaded");
    expect(log).not.toContain("SECRET-VALUE");
    expect(log).toContain("FATAL EXCEPTION");
    expect(r.text).toContain("앱이 죽은 기록");
  });
});
