import Anthropic from "@anthropic-ai/sdk";
import { parseExecution, redactExecutionDir } from "@qa/evidence";
import type { Execution, RunDetail } from "@qa/shared";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, startFakeMessagesApi, type FakeMessagesApi, type FakeReply } from "../../../../../packages/agent/test-support/fake-messages-api";
import { AppDatabase } from "../db/database";
import { AgentJobStore } from "./agent-job-store";
import { JUDGE_SYSTEM_PROMPT, type McpToolResult } from "@qa/agent";
import type { McpConnection } from "./author-service";
import { JudgeError, JudgeService, selectCaptures } from "./judge-service";

const FIXTURES = resolve(__dirname, "../../../../../packages/evidence/fixtures");
const FAKE_SECRETS = ["qa-fixture-id-7f3a", 'fixture"Pw&2026'];

let dir: string;
let db: AppDatabase;
let api: FakeMessagesApi | null;
let redacted: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-judge-svc-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  db.db.prepare("INSERT INTO run (id, workspace, trigger, status, created_at) VALUES ('run-1', 'w', 'manual', 'failed', '2026-10-22T00:00:00.000Z')").run();
  db.db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status, evidence_dir) VALUES ('exec-1', 'run-1', 'TC-0009', 'ios', 'x', 'failed', 'run-1/exec-1')").run();
  redacted = join(dir, "redacted");
  redactExecutionDir(join(FIXTURES, "ios-fail"), redacted, { secrets: FAKE_SECRETS });
  api = null;
});
afterEach(async () => {
  db.close();
  await api?.close();
});

function execution(status: Execution["status"] = "failed", override: Partial<Execution> = {}): Execution {
  const parsed = parseExecution({ dir: redacted });
  return {
    id: "exec-1",
    attempt: 1,
    status,
    durationMs: parsed.durationMs,
    failureClass: null,
    failure: parsed.failure,
    hostLoad: null,
    startedAt: null,
    finishedAt: null,
    warnings: [],
    steps: parsed.steps.map((s) => ({
      index: s.index,
      command: s.command,
      description: s.description,
      status: s.status,
      durationMs: s.durationMs,
      error: s.error?.message ?? null,
      screenshot: s.screenshot,
      failureScreenshot: s.failureScreenshot,
      hierarchy: s.hierarchy,
    })),
    ...override,
  };
}

function detail(exec: Execution): RunDetail {
  return {
    id: "run-1",
    status: exec.status === "passed" ? "passed" : "failed",
    app: "settings",
    flowName: "fixture",
    flowPath: "x",
    tcId: "TC-0009",
    target: "ios",
    deviceId: "SIM-1",
    deviceName: "QA iPhone",
    buildId: null,
    buildLabel: null,
    attempts: 1,
    flaky: false,
    failureMessage: null,
    kept: false,
    evidenceRemoved: false,
    createdAt: "2026-10-22T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    executions: [exec],
  };
}

const verdict = (v: string): FakeReply => () =>
  message([{ type: "text", text: JSON.stringify({ blankScreen: false, verdict: v, defects: v === "fail" ? [{ type: "error_message", description: "오류 문구" }] : [], confidence: 0.8, reason: "근거" }) }], "end_turn", { input: 1500, output: 100 });

async function setup(replies: FakeReply[], exec: Execution, opts: { apiKey?: string | null; rate?: number; provider?: "api" | "claude-app" } = {}) {
  api = await startFakeMessagesApi(replies);
  const logs: Record<string, unknown>[] = [];
  const jobs = new AgentJobStore(db);
  const service = new JudgeService({
    db,
    jobs,
    runs: { get: () => detail(exec) },
    evidence: { redactedDir: () => redacted },
    provider: () => opts.provider ?? "api",
    apiKey: () => (opts.apiKey === undefined ? "test-not-a-real-key" : opts.apiKey),
    monthlyBudgetUsd: () => 100,
    sampleRate: () => opts.rate ?? 0.3,
    createClient: (key) => new Anthropic({ apiKey: key, baseURL: api?.url ?? "", maxRetries: 0 }),
    shrinkImage: async (data, mimeType) => ({ data, mimeType }),
    secrets: () => FAKE_SECRETS,
    auditDir: join(dir, "agent"),
    log: (e) => logs.push(e),
  });
  return { service, jobs, logs };
}

describe("화면 판정 (PLAN 6.7)", () => {
  it("캡처 고르기: 실패면 실패 스텝까지 마지막 3스텝, 통과면 비율 표본(다시 해도 같다)", () => {
    const failed = selectCaptures(execution(), { sampleRate: 0.3 });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.length).toBeLessThanOrEqual(3);
    expect(failed.at(-1)?.expectation).toContain("실패했다");
    const passed = execution("passed");
    expect(selectCaptures(passed, { sampleRate: 0 })).toEqual([]);
    const all = selectCaptures(passed, { sampleRate: 1 });
    expect(all.every((c) => !c.path.includes("screenshots/step-"))).toBe(true);
    expect(selectCaptures(passed, { sampleRate: 0.5 })).toEqual(selectCaptures(passed, { sampleRate: 0.5 }));
  });

  it("고른 캡처마다 한 번씩 판정해 저장하고 작업 비용을 남긴다. 실행 상태는 바꾸지 않는다", async () => {
    const exec = execution();
    const n = selectCaptures(exec, { sampleRate: 0.3 }).length;
    const { service, jobs } = await setup(Array.from({ length: n }, (_, i) => verdict(i === n - 1 ? "fail" : "pass")), exec);
    const out = await service.judgeExecution("run-1", "exec-1", { all: false });
    expect(out).toHaveLength(n);
    expect(out.at(-1)).toMatchObject({ verdict: "fail", defects: [{ type: "error_message" }], reason: "근거", model: "claude-opus-5-5" });
    expect(api?.requests).toHaveLength(n);
    const usage = jobs.usage(100);
    expect(usage.byType).toEqual([{ type: "judge", jobs: 1, costUsd: expect.any(Number) }]);
    expect((db.db.prepare("SELECT status FROM execution WHERE id = 'exec-1'").get() as { status: string }).status).toBe("failed");
    expect(service.list("run-1", "exec-1")).toEqual(out);
  });

  it("키가 없거나 캡처 경로가 증적 폴더 밖이면 판정하지 않는다", async () => {
    await expect((await setup([], execution(), { apiKey: null })).service.judgeExecution("run-1", "exec-1", { all: true })).rejects.toThrow("API 키가 없다");
    const escape = execution("failed", { steps: [{ index: 0, command: "x", description: "x", status: "failed", durationMs: 1, error: "e", screenshot: null, failureScreenshot: "../../../../etc/hosts", hierarchy: null }] });
    const { service, jobs } = await setup([verdict("pass")], escape);
    await expect(service.judgeExecution("run-1", "exec-1", { all: true })).rejects.toThrow(JudgeError);
    expect(api?.requests).toHaveLength(0);
    expect(jobs.usage(100).recent[0]?.status).toBe("failed");
  });

  it("자동 판정: 플로우 만들기 재생·키 없음·비율 0 이면 건너뛰고, 일반 실행이면 판정한다", async () => {
    const exec = execution();
    const n = selectCaptures(exec, { sampleRate: 0.3 }).length;
    const off = await setup([], exec, { rate: 0 });
    await off.service.autoJudge("run-1");
    expect(off.logs).toEqual([{ service: "judge", runId: "run-1", skipped: "sample_rate_0" }]);
    db.db.prepare("UPDATE run SET trigger = 'author' WHERE id = 'run-1'").run();
    const author = await setup([], exec);
    await author.service.autoJudge("run-1");
    expect(author.logs[0]).toMatchObject({ skipped: "trigger author" });
    db.db.prepare("UPDATE run SET trigger = 'manual' WHERE id = 'run-1'").run();
    const on = await setup(Array.from({ length: n }, () => verdict("pass")), exec);
    await on.service.autoJudge("run-1");
    expect(on.logs[0]).toMatchObject({ judged: n });
  });
});

describe("화면 판정 · Claude 앱 방식(MCP, ADR 0022, LLM 없음)", () => {
  const CLAUDE: McpConnection = { id: "conn-1", client: "claude-ai 1.2" };
  const OTHER: McpConnection = { id: "conn-2", client: "claude-code 2.1" };
  const text = (r: McpToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  const judgement = (captureId: number, v: "pass" | "fail") => ({
    captureId,
    blankScreen: false,
    verdict: v,
    defects: v === "fail" ? [{ type: "error_message", description: `오류 문구 ${FAKE_SECRETS[0]}` }] : [],
    confidence: 0.7,
    reason: `근거 ${FAKE_SECRETS[0]}`,
  });
  const totalOf = (exec: Execution) => selectCaptures(exec, { sampleRate: 0, all: true }).length;

  it("Claude 앱에 주는 판정 도구", () => {
    expect(JudgeService.mcpTools().map((t) => t.name)).toEqual(["attach_judge", "get_judge_capture", "submit_judgement", "cancel_judge"]);
    const submit = JudgeService.mcpTools().find((t) => t.name === "submit_judgement");
    expect(submit?.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["captureId", "verdict", "blankScreen", "confidence"]) });
    expect(JudgeService.isMcpTool("attach_judge")).toBe(true);
    expect(JudgeService.isMcpTool("attach_author")).toBe(false);
  });

  it("API 키 없이 시작해 Claude 를 기다리고, Claude 가 캡처를 보고 판정을 내면 배지로 저장하고 끝낸다", async () => {
    const exec = execution();
    const total = totalOf(exec);
    expect(total).toBeGreaterThanOrEqual(2);
    const { service, jobs } = await setup([], exec, { apiKey: null, provider: "claude-app" });
    const started = service.startClaude("run-1", "exec-1");
    expect(started).toMatchObject({ phase: "waiting_claude", total, judged: 0, claudeRequest: expect.stringContaining("attach_judge") });
    expect(started.job.model).toBe("claude-app");
    expect(text(await service.mcpCall(CLAUDE, "get_judge_capture", { captureId: 1 }))).toContain("먼저 attach_judge");

    const attached = text(await service.mcpCall(CLAUDE, "attach_judge", { jobId: started.job.id }));
    expect(attached).toContain(JUDGE_SYSTEM_PROMPT);
    expect(attached).toContain(`${total}/${total}장 남음`);
    expect(attached).not.toContain(FAKE_SECRETS[0]);
    expect(service.claudeStatus(started.job.id)).toMatchObject({ phase: "judging", claudeClient: "claude-ai 1.2" });
    expect(text(await service.mcpCall(OTHER, "attach_judge", {}))).toContain("다른 Claude 대화가 이 작업을 맡고 있다");

    const capture = await service.mcpCall(CLAUDE, "get_judge_capture", { captureId: 1 });
    expect(capture.isError).toBeUndefined();
    expect(capture.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(text(capture)).toContain("<expectation>");
    expect(text(capture)).not.toContain(FAKE_SECRETS[0]);
    expect((await service.mcpCall(CLAUDE, "get_judge_capture", { captureId: total + 1 })).isError).toBe(true);
    // 판정 형식·범위는 API 방식과 같은 규칙으로 검사한다
    expect(text(await service.mcpCall(CLAUDE, "submit_judgement", { captureId: 1, verdict: "pass" }))).toContain("입력 형식이 맞지 않다");
    expect(text(await service.mcpCall(CLAUDE, "submit_judgement", { ...judgement(1, "pass"), confidence: 2 }))).toContain("confidence");

    for (let id = 1; id <= total; id += 1) {
      const reply = text(await service.mcpCall(CLAUDE, "submit_judgement", judgement(id, id === total ? "fail" : "pass")));
      expect(reply).toContain(id === total ? "모든 캡처" : "남은 캡처");
      if (id === 1) expect(text(await service.mcpCall(CLAUDE, "submit_judgement", judgement(1, "pass")))).toContain("이미 판정했다");
    }
    expect(service.claudeStatus(started.job.id)).toMatchObject({ phase: "done", judged: total, claudeRequest: null });
    // 비용은 보이지 않는다(Claude 요금제). 도구 호출: 캡처 읽기 1 + 판정 total
    expect(jobs.get(started.job.id)).toMatchObject({ status: "succeeded", costUsd: 0, toolCalls: 1 + total });
    const list = service.list("run-1", "exec-1");
    expect(list).toHaveLength(total);
    expect(list.at(-1)).toMatchObject({ verdict: "fail", defects: [{ type: "error_message" }], model: "claude-app (claude-ai 1.2)" });
    expect(JSON.stringify(list)).not.toContain(FAKE_SECRETS[0]);
    expect((db.db.prepare("SELECT status FROM execution WHERE id = 'exec-1'").get() as { status: string }).status).toBe("failed");
    expect(text(await service.mcpCall(CLAUDE, "submit_judgement", judgement(1, "pass")))).toContain("진행 중인 화면 판정 작업이 없다");
  });

  it("한 번에 한 작업. 연결이 끊기면 다른 대화가 이어받고, 취소해도 낸 판정은 남는다", async () => {
    const exec = execution();
    const total = totalOf(exec);
    const { service, jobs } = await setup([], exec, { apiKey: null, provider: "claude-app" });
    const { job } = service.startClaude("run-1", "exec-1");
    expect(() => service.startClaude("run-1", "exec-1")).toThrow("이미 Claude 화면 판정이 진행 중");
    await service.mcpCall(CLAUDE, "attach_judge", {});
    await service.mcpCall(CLAUDE, "submit_judgement", judgement(1, "pass"));
    service.releaseConnection(CLAUDE.id);
    expect(service.claudeStatus(job.id).phase).toBe("waiting_claude");
    expect(text(await service.mcpCall(OTHER, "attach_judge", {}))).toContain(`${total - 1}/${total}장 남음`);
    expect(service.cancelClaude(job.id)).toMatchObject({ phase: "done", judged: 1 });
    expect(jobs.get(job.id).status).toBe("canceled");
    expect(service.list("run-1", "exec-1")).toHaveLength(1);
    // 끝났으니 새로 시작할 수 있다
    expect(service.startClaude("run-1", "exec-1").phase).toBe("waiting_claude");
  });

  it("Claude 앱 방식이면 자동 판정을 하지 않는다(사람이 Claude 에 붙여 넣어야 한다)", async () => {
    const { service, logs } = await setup([], execution(), { provider: "claude-app", rate: 1 });
    await service.autoJudge("run-1");
    expect(logs).toEqual([{ service: "judge", runId: "run-1", skipped: "claude_app" }]);
    expect(api?.requests).toHaveLength(0);
  });

  it("끝나지 않은 실행이나 캡처가 없는 실행은 시작하지 않는다", async () => {
    const noShots = execution("failed", { steps: [] });
    const { service } = await setup([], noShots, { apiKey: null, provider: "claude-app" });
    expect(() => service.startClaude("run-1", "exec-1")).toThrow("판정할 화면 캡처가 없다");
  });
});
