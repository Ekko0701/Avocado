import Anthropic from "@anthropic-ai/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Build, Device, RunDetail, RunSummary, StartAuthorInput } from "@qa/shared";
import { FlowMetaSchema } from "@qa/workspace";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createFakeMaestroServer, type FakeCall } from "../../../../../packages/agent/test-support/fake-maestro-mcp";
import { message, startFakeMessagesApi, toolUse, type FakeMessagesApi, type FakeReply } from "../../../../../packages/agent/test-support/fake-messages-api";
import { AppDatabase } from "../db/database";
import type { AuthorContext } from "../workspace/workspace-service";
import { AgentJobStore } from "./agent-job-store";
import { SCREEN_DATA_NOTICE, type McpToolResult } from "@qa/agent";
import { AuthorError, AuthorService, type McpConnection } from "./author-service";

const EXAMPLE = resolve(__dirname, "../../../../../examples/qa-workspace");
const GOOD = readFileSync(join(EXAMPLE, "flows/demo/ios/TC-0101.yaml"), "utf8");
const BAD = 'appId: ${APP_ID}\nname: TC-0101 가입\ntags: [TC-0101]\n---\n- runFlow: common/launch-clean.yaml\n- tapOn:\n    point: "50%,40%"\n- assertVisible: "가입하기"\n- assertVisible: "설정 열기"\n';
const SECRET = "fixture-Pw#2026-author-svc";
const SUBMIT = (yaml: string) => ({ yaml, screenshotsPlan: [], missingIdentifiers: [{ screenKey: "welcome", description: "이메일로 계속하기", fallbackSelector: 'text: "이메일로 계속하기"' }], questions: [], confidence: 0.7 });
const DEVICE: Device = { id: "SIM-1", platform: "ios", kind: "simulator", name: "QA iPhone", osVersion: "27.0", state: "booted", managed: true, serial: null, locale: "ko_KR" };
const INPUT: StartAuthorInput = { app: "demo", tcId: "TC-0101", target: "ios", deviceId: "SIM-1", buildId: null };

let dir: string;
let db: AppDatabase;
let api: FakeMessagesApi | null;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-author-svc-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  api = null;
});
afterEach(async () => {
  db.close();
  await api?.close();
});

const LAUNCH_SUBFLOW = "appId: ${APP_ID}\n---\n- launchApp";

function context(ws: string, launch = LAUNCH_SUBFLOW): AuthorContext {
  return {
    dir: ws,
    tcPath: "testcases/demo/TC-0101.md",
    flowPath: "flows/demo/ios/TC-0101.yaml",
    metaPath: "flows/demo/ios/TC-0101.meta.yaml",
    tc: { id: "TC-0101", title: "가입", markdown: readFileSync(join(EXAMPLE, "testcases/demo/TC-0101.md"), "utf8"), steps: 2, expectations: 2 },
    envKeys: ["DEMO_TEST_PASSWORD"],
    appId: "com.example.demo",
    locale: "ko_KR",
    subflows: [{ path: "common/launch-clean.yaml", text: launch }],
    tcVersion: "abc1234",
  };
}

type ReplayResult = { status: RunSummary["status"]; flaky?: boolean; env?: boolean; error?: string };

function detail(id: string, r: ReplayResult): RunDetail {
  const failed = r.status !== "passed";
  return {
    id,
    status: r.status,
    app: "demo",
    flowName: "TC-0101 이메일 회원가입",
    flowPath: "x",
    tcId: "TC-0101",
    target: "ios",
    deviceId: "SIM-1",
    deviceName: "QA iPhone / iOS 27.0",
    buildId: null,
    buildLabel: "com.example.demo 1.0 (1)",
    attempts: 1,
    flaky: r.flaky ?? false,
    failureMessage: failed ? (r.error ?? "실패") : null,
    kept: false,
    evidenceRemoved: false,
    createdAt: "2026-10-22T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    executions: [
      {
        id: `${id}-e1`,
        attempt: 1,
        status: failed ? "failed" : "passed",
        durationMs: 1000,
        failureClass: r.env ? "env_issue" : failed ? "unknown" : null,
        failure: failed ? { kind: r.env ? "driver_start" : "step_failed", message: r.error ?? "실패", stepIndex: failed && !r.env ? 2 : null } : null,
        hostLoad: null,
        startedAt: null,
        finishedAt: null,
        warnings: [],
        steps: failed && !r.env ? [{ index: 2, command: "tapOnElement", description: 'Tap on "가입하기"', status: "failed", durationMs: 10, error: r.error ?? "Element not found", screenshot: null, failureScreenshot: null, hierarchy: null }] : [],
      },
    ],
  };
}

async function setup(
  replies: FakeReply[],
  replays: ReplayResult[],
  opts: {
    apiKey?: string | null;
    secrets?: Record<string, string>;
    devices?: Device[];
    budget?: number;
    waitGate?: Promise<void>;
    provider?: "api" | "claude-app";
    launch?: string;
    /** 작업 브랜치(또는 main)에 같은 플로우가 이미 있다 */
    unchanged?: "branch" | "main";
  } = {},
) {
  await api?.close();
  api = await startFakeMessagesApi(replies);
  const ws = join(dir, "ws");
  const saved: { yaml: string; meta: string; flowPath: string; draftLeft: boolean }[] = [];
  const branchCalls: string[] = [];
  const draftsSeen: string[] = [];
  const startOptions: unknown[] = [];
  const canceled: string[] = [];
  const jobs = new AgentJobStore(db, { newId: () => `job-${++seq}` });
  // 연결(시도)마다 가짜 maestro 가 받은 호출
  const maestroCalls: FakeCall[][] = [];
  let runN = 0;
  const details = new Map<string, RunDetail>();
  const service = new AuthorService({
    jobs,
    workspace: {
      useTestcaseBranch: async (id) => {
        branchCalls.push(id);
        return "main";
      },
      authorContext: async () => context(ws, opts.launch),
      writeFlowDraft: (flowPath, yaml) => {
        const abs = join(ws, flowPath);
        const previous = existsSync(abs) ? readFileSync(abs, "utf8") : null;
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, yaml);
        return { abs, previous };
      },
      restoreFlowDraft: (flowPath, previous) => {
        rmSync(join(ws, flowPath), { force: true });
        if (previous !== null) writeFileSync(join(ws, flowPath), previous);
      },
      saveFlow: async (input) => {
        // 브랜치를 옮길 수 있게 초안은 커밋 전에 되돌려져 있어야 한다
        const abs = join(ws, input.flowPath);
        saved.push({ yaml: input.yaml, meta: input.meta, flowPath: input.flowPath, draftLeft: existsSync(abs) && readFileSync(abs, "utf8") === input.yaml });
        if (opts.unchanged === "main") return { branch: "main", commit: "0a1b2c3", unchanged: true };
        return { branch: "qa/tester/TC-0101-agent-flow", commit: "f00d123", unchanged: opts.unchanged === "branch" };
      },
    },
    runs: {
      start: async (input, options) => {
        startOptions.push(options);
        draftsSeen.push(readFileSync(input.flowPath, "utf8"));
        const id = `run-${++runN}`;
        const r = replays[runN - 1];
        if (!r) throw new Error("준비한 재생 결과가 없다");
        details.set(id, detail(id, r));
        return details.get(id) as RunSummary;
      },
      wait: async () => {
        await opts.waitGate;
      },
      get: (id) => details.get(id) as RunDetail,
      cancel: (id) => {
        canceled.push(id);
        return details.get(id) as RunSummary;
      },
    },
    devices: { list: async () => ({ devices: opts.devices ?? [DEVICE] }) },
    builds: { get: () => ({}) as Build, install: async () => ({ installed: true }) },
    provider: () => opts.provider ?? "api",
    monthlyBudgetUsd: () => opts.budget ?? 100,
    apiKey: () => (opts.apiKey === undefined ? "test-not-a-real-key" : opts.apiKey),
    accountSecrets: () => opts.secrets ?? { DEMO_TEST_PASSWORD: SECRET },
    defaultLocale: () => "ko_KR",
    createClient: (key) => new Anthropic({ apiKey: key, baseURL: api?.url ?? "", maxRetries: 0 }),
    connectMaestro: async () => {
      const { server, calls } = createFakeMaestroServer({ screenText: `text: 가입하기\nvalue: ${SECRET}` });
      maestroCalls.push(calls);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      return c;
    },
    auditDir: join(dir, "agent"),
  });
  return { service, jobs, saved, branchCalls, draftsSeen, startOptions, canceled, maestroCalls, flowFile: join(ws, "flows/demo/ios/TC-0101.yaml") };
}

const explore = (yaml: string): FakeReply[] => [
  () => toolUse("begin_step", { step: 1 }),
  () => toolUse("maestro_inspect_screen", {}),
  () => toolUse("begin_step", { step: 2 }),
  () => toolUse("submit_flow", SUBMIT(yaml)),
  () => message([{ type: "text", text: "제출했다" }], "end_turn"),
];

function userMessageOf(requestIndex: number): string {
  return JSON.stringify(api?.requests[requestIndex]?.messages[0]);
}

describe("AuthorService (가짜 API·maestro mcp·재생)", () => {
  it("탐색 → 규약 검사 → 2회 재생 통과 → 플로우·meta 커밋", async () => {
    const { service, jobs, saved, branchCalls, draftsSeen, startOptions } = await setup(explore(GOOD), [{ status: "passed" }, { status: "passed" }]);
    expect(service.current()).toBeNull();
    const started = await service.start(INPUT);
    expect(started.job.status).toBe("running");
    // 화면을 다시 열면 진행 중인 작업을 되찾는다
    expect(service.current()).toMatchObject({ job: { id: started.job.id, status: "running" }, app: "demo", tcId: "TC-0101" });
    // 시작할 때 이 TC 의 작업 브랜치(없으면 main)로 옮긴다. 진행 중에는 다른 화면이 브랜치를 바꾸지 못한다
    expect(branchCalls).toEqual(["TC-0101"]);
    expect(service.busy()).toMatch(/플로우 만들기/);
    await service.wait(started.job.id);
    const status = service.status(started.job.id);
    expect(status.job.status).toBe("succeeded");
    expect(status.result).toEqual({ flowPath: "flows/demo/ios/TC-0101.yaml", branch: "qa/tester/TC-0101-agent-flow", commit: "f00d123", goldenRunId: "run-2", unchanged: false });
    expect(status.replays.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(draftsSeen).toEqual([GOOD, GOOD]);
    // 재생은 빌드 없이 앱 id 를 넣고, TC 역할 키만, author 로 기록
    expect(startOptions).toEqual([
      { appId: "com.example.demo", envKeys: ["DEMO_TEST_PASSWORD"], trigger: "author" },
      { appId: "com.example.demo", envKeys: ["DEMO_TEST_PASSWORD"], trigger: "author" },
    ]);
    expect(saved[0]?.yaml).toBe(GOOD);
    expect(saved[0]?.draftLeft).toBe(false);
    expect(service.busy()).toBeNull();
    // 끝난 뒤에도 이번 실행의 마지막 작업으로 결과를 보여 준다
    expect(service.current()).toMatchObject({ job: { id: started.job.id, status: "succeeded" }, result: { commit: "f00d123" } });
    const meta = FlowMetaSchema.parse(parse(saved[0]?.meta ?? ""));
    expect(meta).toMatchObject({
      tc: "TC-0101",
      tcVersion: "abc1234",
      generatedBy: "agent",
      agentModel: "claude-opus-5-5",
      goldenRun: { appBuild: "com.example.demo 1.0 (1)", device: "QA iPhone / iOS 27.0", result: "passed" },
      missingIdentifiers: [{ screen: "welcome", element: "이메일로 계속하기", fallback: 'text: "이메일로 계속하기"' }],
    });
    expect(jobs.get(started.job.id).costUsd).toBeGreaterThan(0);
    expect(jobs.get(started.job.id).toolCalls).toBe(1);
    const audit = readFileSync(join(dir, "agent", `${started.job.id}.jsonl`), "utf8");
    expect(audit).not.toContain(SECRET);
    expect(JSON.stringify(api?.requests)).not.toContain(SECRET);
    expect(status.log.map((l) => l.message)).toEqual(expect.arrayContaining(["스텝 1/2", "재생 2/2", "두 번 모두 통과했다. 작업 브랜치에 커밋한다"]));

    // 앱을 다시 시작한 뒤(진행 정보 없음)에도 저장한 결과로 보여 준다
    const { service: restarted } = await setup([], []);
    expect(restarted.status(started.job.id)).toMatchObject({ phase: "done", tcId: "TC-0101", result: status.result, submission: { yaml: GOOD } });
    // 다시 시작한 앱에는 이어 볼 작업이 없다(지난 작업은 사용량·기록으로 본다)
    expect(restarted.current()).toBeNull();
  });

  it("규약 오류면 문제를 알려 한 번 다시 시도한다", async () => {
    const { service, saved } = await setup([...explore(BAD), ...explore(GOOD)], [{ status: "passed" }, { status: "passed" }]);
    const { job } = await service.start(INPUT);
    await service.wait(job.id);
    const status = service.status(job.id);
    expect(status.job.status).toBe("succeeded");
    expect(status.attempt).toBe(2);
    expect(saved).toHaveLength(1);
    const retry = userMessageOf(5);
    expect(retry).toContain("previous_attempt");
    expect(retry).toContain("flow-coordinates");
  });

  it("두 시도 모두 재생에 실패하면 실패로 끝내고 초안을 되돌린다", async () => {
    const { service, saved, flowFile } = await setup([...explore(GOOD), ...explore(GOOD)], [
      { status: "failed", error: 'Element not found: "가입하기"' },
      { status: "passed", flaky: true },
    ]);
    const { job } = await service.start(INPUT);
    await service.wait(job.id);
    const status = service.status(job.id);
    expect(status.job.status).toBe("failed");
    expect(status.job.error).toContain("2번 시도");
    expect(status.replays).toHaveLength(2);
    expect(userMessageOf(5)).toContain("Element not found");
    expect(saved).toHaveLength(0);
    // 원래 없던 플로우라 초안을 지운다
    expect(existsSync(flowFile)).toBe(false);
  });

  it("기기 환경 문제(드라이버 시작 실패)는 플로우 탓이 아니므로 다시 시도하지 않는다", async () => {
    const { service } = await setup(explore(GOOD), [{ status: "error", env: true, error: "driver did not start" }]);
    const { job } = await service.start(INPUT);
    await service.wait(job.id);
    const status = service.status(job.id);
    expect(status.job.status).toBe("failed");
    expect(status.job.error).toContain("기기 환경 문제");
    expect(api?.requests).toHaveLength(5);
  });

  it("시작 조건: 키, 기기 상태, 계정 값, 월 상한", async () => {
    await expect((await setup([], [], { apiKey: null })).service.start(INPUT)).rejects.toThrow("Anthropic API 키가 없다");
    await expect((await setup([], [], { devices: [{ ...DEVICE, state: "shutdown" }] })).service.start(INPUT)).rejects.toThrow("실행 중이 아니다");
    await expect((await setup([], [], { secrets: {} })).service.start(INPUT)).rejects.toThrow("계정 값이 없다: demo · DEMO_TEST_PASSWORD");
    const s = await setup([], [], { budget: 1 });
    const id = s.jobs.create({ type: "author", model: "claude-opus-5-5", input: {} });
    s.jobs.recordUsage(id, { toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5, elapsedMs: 0 });
    await expect(s.service.start(INPUT)).rejects.toThrow(AuthorError);
  });

  it("작업 비용 상한을 넘으면 budget_exceeded 로 끝내고 재생하지 않는다", async () => {
    const { service, draftsSeen } = await setup([() => toolUse("begin_step", { step: 1 }, { input: 2_000_000, output: 0 })], []);
    const { job } = await service.start(INPUT);
    await service.wait(job.id);
    const status = service.status(job.id);
    expect(status.job.status).toBe("budget_exceeded");
    expect(status.job.costUsd).toBeGreaterThan(5);
    expect(draftsSeen).toHaveLength(0);
  });

  it("취소하면 진행 중인 요청을 끊고 canceled 로 끝낸다", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { service } = await setup([async () => {
      await gate;
      return toolUse("begin_step", { step: 1 });
    }], []);
    const { job } = await service.start(INPUT);
    await new Promise((r) => setTimeout(r, 50));
    service.cancel(job.id);
    release();
    await service.wait(job.id);
    expect(service.status(job.id).job.status).toBe("canceled");
    // 끝난 뒤에는 새 작업을 시작할 수 있다(준비한 응답이 없어 곧 실패한다)
    const next = await service.start(INPUT);
    await service.wait(next.job.id);
    expect(service.status(next.job.id).job.status).toBe("failed");
  });

  it("제출에 계정 값이 그대로 있으면 가린 것만 남기고 다시 시도한다(모델에게도 가린 것을 돌려준다)", async () => {
    const leaky = GOOD.replace("${DEMO_TEST_PASSWORD}", `"${SECRET}"`);
    const { service, saved } = await setup([...explore(leaky), ...explore(GOOD)], [{ status: "passed" }, { status: "passed" }]);
    const { job } = await service.start(INPUT);
    await service.wait(job.id);
    expect(service.status(job.id).job.status).toBe("succeeded");
    const retry = userMessageOf(5);
    expect(retry).toContain("계정 값이 그대로");
    expect(retry).not.toContain(SECRET);
    expect(retry).toContain("***");
    // 두 번째 시도의 대화 전체에는 값이 없다(첫 시도 대화의 모델 자신의 출력은 그대로 남는다)
    expect(JSON.stringify(api?.requests.slice(5))).not.toContain(SECRET);
    expect(saved[0]?.yaml).toBe(GOOD);
  });

  it("작업 브랜치에 같은 플로우·meta 가 이미 있으면 실패가 아니라 기존 커밋으로 성공한다", async () => {
    const { service } = await setup(explore(GOOD), [{ status: "passed" }, { status: "passed" }], { unchanged: "branch" });
    const { job } = await service.start(INPUT);
    await service.wait(job.id);
    const status = service.status(job.id);
    expect(status.job).toMatchObject({ status: "succeeded", error: null });
    expect(status.result).toMatchObject({ branch: "qa/tester/TC-0101-agent-flow", commit: "f00d123", unchanged: true });
    expect(status.log.map((l) => l.message)).toContain("같은 플로우가 이미 qa/tester/TC-0101-agent-flow 에 있다(f00d123). 새로 커밋하지 않았다");
  });

  it("main 에 승인된 플로우와 같으면 main 의 커밋으로 성공하고 Claude 에게 검토 요청이 필요 없다고 알린다", async () => {
    const { service } = await setup([], [{ status: "passed" }, { status: "passed" }], { provider: "claude-app", apiKey: null, unchanged: "main" });
    const claude = { id: "conn-u", client: "claude-code 2.1.220" };
    const { job } = await service.start(INPUT);
    await service.mcpCall(claude, "author_status", { waitSeconds: 5 });
    await service.mcpCall(claude, "attach_author", {});
    await service.mcpCall(claude, "submit_flow", SUBMIT(GOOD));
    const done = (await service.mcpCall(claude, "author_status", { waitSeconds: 10 })).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(done).toContain("이미 main 에 승인돼 있어 새로 커밋하지 않았다");
    expect(done).toContain("검토 요청은 필요 없다");
    expect(service.status(job.id).result).toMatchObject({ branch: "main", unchanged: true });
  });

  it("재생 중에 취소하면 재생을 멈추고 커밋하지 않는다", async () => {
    let release: () => void = () => {};
    const waitGate = new Promise<void>((r) => (release = r));
    const { service, saved, canceled } = await setup(explore(GOOD), [{ status: "passed" }, { status: "passed" }], { waitGate });
    const { job } = await service.start(INPUT);
    for (let i = 0; i < 50 && service.status(job.id).phase !== "replaying"; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(service.status(job.id).phase).toBe("replaying");
    service.cancel(job.id);
    release();
    await service.wait(job.id);
    expect(service.status(job.id).job.status).toBe("canceled");
    expect(canceled).toEqual(["run-1"]);
    expect(saved).toEqual([]);
  });

  it("시작 확인 중(await 사이)에도 두 번째 시작은 거부한다", async () => {
    const { service } = await setup(explore(GOOD), [{ status: "passed" }, { status: "passed" }]);
    const first = service.start(INPUT);
    await expect(service.start(INPUT)).rejects.toThrow("이미 플로우 만들기가 진행 중");
    const { job } = await first;
    await service.wait(job.id);
  });

  it("가릴 수 없을 만큼 짧은 계정 값이면 시작하지 않는다", async () => {
    const { service } = await setup([], [], { secrets: { DEMO_TEST_PASSWORD: "ab" } });
    await expect(service.start(INPUT)).rejects.toThrow("너무 짧아");
  });
});

describe("AuthorService · Claude 앱 방식(MCP, ADR 0022, 가짜 maestro mcp·재생, LLM 없음)", () => {
  const CLAUDE: McpConnection = { id: "conn-1", client: "claude-code 2.1.220" };
  const OTHER: McpConnection = { id: "conn-2", client: "claude-ai 1.0" };
  const text = (r: McpToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  const claudeSetup = (replays: ReplayResult[]) => setup([], replays, { provider: "claude-app", apiKey: null });

  it("Claude 앱이 연결할 때 받는 도구 목록은 작업이 없어도 같다", () => {
    expect(AuthorService.mcpTools().map((t) => t.name)).toEqual([
      "attach_author",
      "author_status",
      "cancel_author",
      "maestro_inspect_screen",
      "maestro_take_screenshot",
      "maestro_run",
      "maestro_cheat_sheet",
      "begin_step",
      "ask_planner",
      "submit_flow",
    ]);
  });

  it("API 키 없이 시작해 Claude 를 기다리고, Claude 가 맡아 탐색·제출하면 앱이 검사·2회 재생·커밋한다", async () => {
    const { service, jobs, saved, maestroCalls } = await claudeSetup([{ status: "passed" }, { status: "passed" }]);
    const started = await service.start(INPUT);
    expect(started).toMatchObject({ driver: "claude-app", claudeRequest: expect.stringContaining("attach_author") });
    expect(started.job.model).toBe("claude-app");
    // 맡기 전에는 기기 도구를 쓸 수 없다
    expect(text(await service.mcpCall(CLAUDE, "maestro_inspect_screen", {}))).toContain("먼저 attach_author");
    // 준비(maestro 연결·화면 미리 읽기)가 끝날 때까지 기다린다
    const ready = text(await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 5 }));
    expect(ready).toContain("기기 도구를 쓸 수 있다");
    // 시작 서브플로우는 앱이 준비 단계에서 대신 실행했다(Claude 의 첫 명령이 시간 제한에 걸리지 않게)
    expect(ready).toContain("common/launch-clean.yaml 를 실행해 시작 상태를 만들어 두었다");
    expect(maestroCalls[0]?.[0]).toMatchObject({ tool: "run", args: { yaml: expect.stringContaining("- launchApp") } });
    expect(service.status(started.job.id).phase).toBe("waiting_claude");

    const attached = await service.mcpCall(CLAUDE, "attach_author", { jobId: started.job.id });
    expect(attached.isError).toBeUndefined();
    const instructions = text(attached);
    expect(instructions).toContain(SCREEN_DATA_NOTICE);
    expect(instructions).toContain("앱이 준비 단계에서 common/launch-clean.yaml 를 대신 실행해 만든다");
    expect(instructions).toContain("한 번에 짧은 명령 묶음만");
    expect(instructions).toContain('<testcase id="TC-0101">');
    expect(instructions).toContain("DEMO_TEST_PASSWORD");
    expect(instructions).not.toContain(SECRET);
    expect(service.status(started.job.id)).toMatchObject({ phase: "exploring", claudeClient: "claude-code 2.1.220" });

    expect(text(await service.mcpCall(CLAUDE, "begin_step", { step: 1 }))).toContain("스텝 1/2");
    const screen = text(await service.mcpCall(CLAUDE, "maestro_inspect_screen", {}));
    expect(screen).toContain("<screen_data>");
    expect(screen).not.toContain(SECRET);
    // 기기는 앱이 배정한다
    expect(await service.mcpCall(CLAUDE, "maestro_list_devices", {})).toMatchObject({ isError: true });
    expect(await service.mcpCall(CLAUDE, "begin_step", { step: "2" })).toMatchObject({ isError: true });
    await service.mcpCall(CLAUDE, "begin_step", { step: 2 });
    expect(text(await service.mcpCall(CLAUDE, "submit_flow", SUBMIT(GOOD)))).toContain("author_status");
    // 앱이 검사·재생하는 동안 기기 도구는 닫힌다
    expect(text(await service.mcpCall(CLAUDE, "maestro_inspect_screen", {}))).toContain("지금은 기기 도구를 쓸 수 없다");

    const done = text(await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 10 }));
    expect(done).toContain("커밋했다");
    await service.wait(started.job.id);
    expect(FlowMetaSchema.parse(parse(saved[0]?.meta ?? "")).agentModel).toBe("claude-app (claude-code 2.1.220)");
    // 비용은 보이지 않는다(Claude 요금제). 도구 호출: 앱의 시작 서브플로우 1 + Claude 의 화면 읽기 1
    expect(jobs.get(started.job.id)).toMatchObject({ status: "succeeded", model: "claude-app", costUsd: 0, toolCalls: 2 });
    expect(service.status(started.job.id).claudeRequest).toBeNull();
    const audit = readFileSync(join(dir, "agent", `${started.job.id}.jsonl`), "utf8");
    expect(audit).toContain('"claude_attach"');
    expect(audit).not.toContain(SECRET);
  });

  it("재생에 실패하면 같은 대화에 문제를 알려 한 번 더 고쳐 제출하게 한다", async () => {
    const { service, maestroCalls } = await claudeSetup([{ status: "failed", error: "Element not found: 가입하기" }, { status: "passed" }, { status: "passed" }]);
    const { job } = await service.start(INPUT);
    await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 5 });
    await service.mcpCall(CLAUDE, "attach_author", {});
    await service.mcpCall(CLAUDE, "submit_flow", SUBMIT(GOOD));
    const retry = text(await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 10 }));
    expect(retry).toContain("직전 제출이 통과하지 못했다");
    expect(retry).toContain("Element not found: 가입하기");
    expect(service.status(job.id)).toMatchObject({ attempt: 2, phase: "exploring" });
    // 다시 시도하기 전에도 앱이 시작 상태로 다시 띄운다
    expect(retry).toContain("시작 상태를 만들어 두었다");
    expect(maestroCalls[1]?.[0]?.tool).toBe("run");
    await service.mcpCall(CLAUDE, "submit_flow", SUBMIT(GOOD));
    expect(text(await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 10 }))).toContain("커밋했다");
  });

  it("시작 서브플로우가 실패해도 작업을 끝내지 않고, Claude 에게 이유와 나눠 실행하라는 안내를 준다", async () => {
    const { service } = await setup([], [], { provider: "claude-app", apiKey: null, launch: "appId: ${APP_ID}\n---\n- tapOn: FAIL" });
    const { job } = await service.start(INPUT);
    const status = text(await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 5 }));
    expect(status).toContain("common/launch-clean.yaml 를 실행하지 못했다");
    expect(status).toContain("짧게 나눠 maestro_run 으로 실행해");
    expect(service.status(job.id)).toMatchObject({ phase: "waiting_claude" });
    expect(service.status(job.id).log.map((l) => l.message)).toEqual(expect.arrayContaining([expect.stringContaining("시작 서브플로우 실패")]));
    service.cancel(job.id);
    await service.wait(job.id);
  });

  it("한 작업은 한 대화만 맡는다. 연결이 끊기면 다른 대화가 이어받고, cancel_author 로 취소할 수 있다", async () => {
    const { service, saved } = await claudeSetup([]);
    const { job } = await service.start(INPUT);
    await service.mcpCall(CLAUDE, "author_status", { waitSeconds: 5 });
    await service.mcpCall(CLAUDE, "attach_author", {});
    expect(text(await service.mcpCall(OTHER, "attach_author", {}))).toContain("다른 Claude 대화가 이 작업을 맡고 있다");
    expect(text(await service.mcpCall(OTHER, "maestro_run", { yaml: "- launchApp" }))).toContain("이 대화가 맡은 작업이 아니다");

    service.releaseConnection(CLAUDE.id);
    expect(service.status(job.id).phase).toBe("waiting_claude");
    expect((await service.mcpCall(OTHER, "attach_author", { jobId: job.id })).isError).toBeUndefined();
    expect(service.status(job.id).claudeClient).toBe("claude-ai 1.0");

    expect(text(await service.mcpCall(OTHER, "cancel_author", {}))).toContain(job.id);
    await service.wait(job.id);
    expect(service.status(job.id).job.status).toBe("canceled");
    expect(saved).toEqual([]);
  });

  it("작업이 없거나 다른 작업 id 면 이유를 돌려준다", async () => {
    const { service } = await claudeSetup([]);
    expect(text(await service.mcpCall(CLAUDE, "author_status", {}))).toContain("진행 중인 작업이 없다");
    expect(text(await service.mcpCall(CLAUDE, "attach_author", {}))).toContain("먼저 시작한다");
    const { job } = await service.start(INPUT);
    expect(text(await service.mcpCall(CLAUDE, "attach_author", { jobId: "job-999" }))).toContain(`지금 작업은 ${job.id}`);
    service.cancel(job.id);
    await service.wait(job.id);
  });
});
