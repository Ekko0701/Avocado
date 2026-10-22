import Anthropic from "@anthropic-ai/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMaestroServer, type FakeCall } from "../test-support/fake-maestro-mcp";
import { message, startFakeMessagesApi, toolUse, type FakeMessagesApi, type FakeReply } from "../test-support/fake-messages-api";
import { AuditLog } from "./audit";
import { Budget, BudgetExceededError, MODE_LIMITS, type BudgetLimits } from "./budget";
import { McpBridge } from "./mcp-bridge";
import { MAESTRO_POLICY } from "./policy";
import { AgentRefusalError, runToolLoop } from "./run-loop";
import { SCREEN_DATA_NOTICE } from "./screen-data";

const SECRET = "fixture-Pw#2026-loop";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

async function setup(replies: FakeReply[], limits: BudgetLimits = MODE_LIMITS.author) {
  const api: FakeMessagesApi = await startFakeMessagesApi(replies);
  const { server, calls } = createFakeMaestroServer({ screenText: `id: password_field\ntext: ${SECRET}` });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const auditFile = join(mkdtempSync(join(tmpdir(), "qa-loop-")), "audit.jsonl");
  const audit = new AuditLog(auditFile, { jobId: "job-loop", secrets: [SECRET] });
  const budget = new Budget(limits, { monthlyRemainingUsd: 10 });
  const bridge = await McpBridge.connect(clientSide, { serverName: "maestro", policy: MAESTRO_POLICY.author, deviceId: "SIM-1", env: { DEMO_TEST_PASSWORD: SECRET }, budget, audit });
  cleanup.push(() => bridge.close(), () => api.close());
  // 실제 키가 아니다. 가짜 서버만 받는다
  const client = new Anthropic({ apiKey: "test-not-a-real-key", baseURL: api.url, maxRetries: 0 });
  const run = () => runToolLoop({ client, effort: "medium", system: "TC 를 Maestro 플로우로 만든다.", messages: [{ role: "user", content: "TC-0101" }], tools: bridge.tools(), budget, audit, maxTokens: 4096 });
  return { api, calls, auditFile, budget, run };
}

function toolResults(api: FakeMessagesApi, index: number): string {
  const last = api.requests[index]?.messages.at(-1);
  return JSON.stringify(last?.content ?? null);
}

async function rejected(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("실패하지 않았다");
}

describe("runToolLoop (가짜 Messages API + 가짜 maestro mcp, 실제 API 호출 없음)", () => {
  it("도구 호출을 돌고 usage 를 예산·감사 기록에 더한다. 요청 형식은 CLAUDE.md 8장을 따른다", async () => {
    const { api, calls, auditFile, budget, run } = await setup([
      () => toolUse("maestro_inspect_screen", {}),
      () => toolUse("maestro_run", { yaml: "- inputText: ${DEMO_TEST_PASSWORD}" }),
      () => message([{ type: "text", text: "완료" }], "end_turn"),
    ]);
    const result = await run();
    expect(result.iterations).toBe(3);
    expect(result.final.stop_reason).toBe("end_turn");

    const first = api.requests[0];
    expect(first?.model).toBe("claude-opus-5-5");
    expect(first?.output_config).toEqual({ effort: "medium" });
    expect(first?.thinking).toBeUndefined();
    expect(first?.tool_choice).toBeUndefined();
    expect(JSON.stringify(first?.system)).toContain(SCREEN_DATA_NOTICE);
    expect(first?.tools?.map((t) => t.name)).not.toContain("maestro_run_on_cloud");

    // 모델에게 돌아간 도구 결과: 화면 데이터는 감싸고, 계정 값은 어디에도 없다
    expect(toolResults(api, 1)).toContain("<screen_data>");
    expect(JSON.stringify(api.requests)).not.toContain(SECRET);
    expect(calls.map((c: FakeCall) => c.tool)).toEqual(["inspect_screen", "run"]);
    expect(calls[1]?.args["env"]).toEqual({ DEMO_TEST_PASSWORD: SECRET });

    expect(budget.snapshot()).toMatchObject({ toolCalls: 2, inputTokens: 3000, outputTokens: 300 });
    expect(budget.snapshot().costUsd).toBeCloseTo((3000 * 4 + 300 * 20) / 1e6, 9);
    const audit = readFileSync(auditFile, "utf8");
    expect(audit.match(/"model_usage"/g)).toHaveLength(3);
    expect(audit).not.toContain(SECRET);
  });

  it("대화를 캐시한다: 요청마다 자동 캐시를 켜고, 앞 요청의 대화는 바뀌지 않은 채 다음 요청의 앞부분이 된다", async () => {
    const { api, run } = await setup([
      () => toolUse("maestro_inspect_screen", {}),
      () => toolUse("maestro_list_devices", {}),
      () => message([{ type: "text", text: "완료" }], "end_turn"),
    ]);
    await run();
    expect(api.requests).toHaveLength(3);
    for (const request of api.requests) {
      expect(request["cache_control"]).toEqual({ type: "ephemeral" });
      expect(JSON.stringify(request.system)).toContain('"cache_control":{"type":"ephemeral"}');
    }
    // 앞부분이 한 바이트라도 바뀌면 그 뒤 캐시가 모두 깨진다. 실행기는 뒤에 붙이기만 해야 한다
    for (let i = 1; i < api.requests.length; i += 1) {
      const previous = api.requests[i - 1]?.messages ?? [];
      const next = api.requests[i]?.messages ?? [];
      expect(next.length).toBeGreaterThan(previous.length);
      expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
      expect(api.requests[i]?.system).toEqual(api.requests[0]?.system);
      expect(api.requests[i]?.tools).toEqual(api.requests[0]?.tools);
    }
  });

  it("캐시 읽기·쓰기 사용량도 비용에 넣는다(읽기 0.05배, 5분 쓰기 1.25배)", async () => {
    const { budget, run } = await setup([
      () => toolUse("maestro_list_devices", {}, { input: 100, output: 50, cacheWrite: 8000 }),
      () => message([{ type: "text", text: "완료" }], "end_turn", { input: 100, output: 50, cacheRead: 8000, cacheWrite: 500 }),
    ]);
    await run();
    expect(budget.snapshot()).toMatchObject({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 8500 });
    expect(budget.snapshot().costUsd).toBeCloseTo((200 * 4 + 100 * 20 + 8000 * 0.2 + 8500 * 4 * 1.25) / 1e6, 9);
  });

  it("거절(stop_reason refusal)은 AgentRefusalError", async () => {
    const { run } = await setup([() => message([{ type: "text", text: "도울 수 없다" }], "refusal")]);
    expect(await rejected(run())).toBeInstanceOf(AgentRefusalError);
  });

  it("비용 상한을 넘으면 그 응답의 도구를 실행하지 않고 끝낸다", async () => {
    const { api, calls, run } = await setup([() => toolUse("maestro_list_devices", {}, { input: 1_000_000, output: 0 })], { ...MODE_LIMITS.author, maxCostUsd: 1 });
    const error = await rejected(run());
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).reason).toBe("job_cost");
    expect(api.requests).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("도구 호출 상한을 넘으면 실행기 루프를 끊는다(모델에게 오류만 돌려주고 계속 돌지 않는다)", async () => {
    const { api, calls, run } = await setup(
      [() => toolUse("maestro_list_devices", {}), () => toolUse("maestro_list_devices", {}), () => toolUse("maestro_list_devices", {}), () => message([{ type: "text", text: "끝" }], "end_turn")],
      { ...MODE_LIMITS.author, maxToolCallsPerStep: 1 },
    );
    const error = await rejected(run());
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).reason).toBe("step_tool_calls");
    expect(calls).toHaveLength(1);
    expect(api.requests.length).toBeLessThanOrEqual(2);
  });
});
