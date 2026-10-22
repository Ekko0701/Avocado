import Anthropic from "@anthropic-ai/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMaestroServer, type FakeCall } from "../../test-support/fake-maestro-mcp";
import { message, startFakeMessagesApi, toolUse, type FakeMessagesApi, type FakeReply } from "../../test-support/fake-messages-api";
import { AuditLog } from "../audit";
import { Budget, MODE_LIMITS } from "../budget";
import { McpBridge } from "../mcp-bridge";
import { MAESTRO_POLICY } from "../policy";
import type { AuthorInput } from "./prompt";
import { runAuthor } from "./run-author";
import type { AuthorEvent } from "./tools";

const SECRET = "fixture-Pw#2026-author";
const FLOW = 'appId: ${APP_ID}\nname: TC-0101 가입\ntags: [TC-0101]\n---\n- runFlow: common/launch-clean.yaml\n- extendedWaitUntil:\n    visible: "가입하기"\n    timeout: 10000\n- takeScreenshot: 01_signup\n';
const SUBMIT = { yaml: FLOW, screenshotsPlan: [{ stepIndex: 1, screenKey: "signup" }], missingIdentifiers: [{ screenKey: "welcome", description: "이메일로 계속하기", fallbackSelector: 'text: "이메일로 계속하기"' }], questions: [], confidence: 0.8 };
const INPUT: AuthorInput = {
  tc: { id: "TC-0101", title: "가입", markdown: "---\nid: TC-0101\n---\n## 스텝\n1. 가입한다\n   - 기대: 홈 화면\n2. 확인한다\n   - 기대: 코드", steps: 2 },
  app: "demo",
  target: "ios",
  appId: "com.example.demo",
  locale: "ko_KR",
  envKeys: ["DEMO_TEST_PASSWORD"],
  subflows: [{ path: "common/launch-clean.yaml", text: "appId: ${APP_ID}\n---\n- clearState\n- launchApp" }],
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

async function setup(replies: FakeReply[]) {
  const api: FakeMessagesApi = await startFakeMessagesApi(replies);
  const { server, calls } = createFakeMaestroServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), "qa-author-")), "audit.jsonl"), { jobId: "job-author", secrets: [SECRET] });
  const budget = new Budget(MODE_LIMITS.author, { monthlyRemainingUsd: 10 });
  const bridge = await McpBridge.connect(c, { serverName: "maestro", policy: MAESTRO_POLICY.author, deviceId: "SIM-1", env: { DEMO_TEST_PASSWORD: SECRET }, budget, audit });
  cleanup.push(() => bridge.close(), () => api.close());
  const events: AuthorEvent[] = [];
  const client = new Anthropic({ apiKey: "test-not-a-real-key", baseURL: api.url, maxRetries: 0 });
  const run = () => runAuthor({ client, input: INPUT, deviceTools: bridge.tools(), budget, audit, onEvent: (e) => events.push(e) });
  return { api, calls, events, run };
}

function lastToolResult(api: FakeMessagesApi, index: number): { content: unknown; is_error?: boolean } | undefined {
  const content = api.requests[index]?.messages.at(-1)?.content;
  return Array.isArray(content) ? (content.find((b: { type?: string }) => b.type === "tool_result") as { content: unknown; is_error?: boolean }) : undefined;
}

describe("runAuthor (가짜 API·가짜 maestro mcp)", () => {
  it("스텝을 돌며 기기를 탐색하고 submit_flow 로 제출한다", async () => {
    const { api, calls, events, run } = await setup([
      () => toolUse("begin_step", { step: 1 }),
      () => toolUse("maestro_inspect_screen", {}),
      () => toolUse("maestro_run", { yaml: "- tapOn: 이메일로 계속하기" }),
      () => toolUse("begin_step", { step: 2 }),
      () => toolUse("ask_planner", { question: "닉네임 규칙이 있나요?" }),
      () => toolUse("submit_flow", SUBMIT),
      () => message([{ type: "text", text: "제출했다" }], "end_turn"),
    ]);
    const result = await run();
    expect(result.submission).toEqual(SUBMIT);
    expect(result.questions).toEqual(["닉네임 규칙이 있나요?"]);
    expect(result.stopReason).toBe("end_turn");
    expect(calls.map((c: FakeCall) => c.tool)).toEqual(["inspect_screen", "run"]);
    expect(events.filter((e) => e.type !== "tool")).toEqual([
      { type: "step", step: 1, total: 2 },
      { type: "step", step: 2, total: 2 },
      { type: "question", question: "닉네임 규칙이 있나요?" },
      { type: "submitted" },
    ]);

    // 요청 형식(PLAN 8장): effort high, 서버 측 폴백, strict 제출 도구, 캐시되는 시스템 프롬프트
    const first = api.requests[0];
    expect(first?.output_config).toEqual({ effort: "high" });
    expect(first?.["fallbacks"]).toBe("default");
    expect(api.betas[0]).toContain("server-side-fallback-2026-07-01");
    expect(first?.tools?.find((t) => t.name === "submit_flow")).toMatchObject({ strict: true, input_schema: { additionalProperties: false } });
    expect(first?.system).toEqual([expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } })]);
    const user = JSON.stringify(first?.messages[0]);
    expect(user).toContain("TC-0101");
    expect(user).toContain("DEMO_TEST_PASSWORD");
    expect(JSON.stringify(api.requests)).not.toContain(SECRET);
  });

  it("잘못된 제출·스텝 되돌리기는 오류 결과로 돌려주고, 고친 제출을 받는다", async () => {
    const { api, run } = await setup([
      () => toolUse("begin_step", { step: 2 }),
      () => toolUse("begin_step", { step: 1 }),
      () => toolUse("submit_flow", { ...SUBMIT, confidence: 3 }),
      () => toolUse("submit_flow", { ...SUBMIT, yaml: FLOW, extra: true }),
      () => toolUse("submit_flow", SUBMIT),
      () => message([{ type: "text", text: "끝" }], "end_turn"),
    ]);
    const result = await run();
    expect(lastToolResult(api, 2)?.is_error).toBe(true);
    expect(lastToolResult(api, 3)?.is_error).toBe(true);
    expect(JSON.stringify(lastToolResult(api, 3)?.content)).toContain("confidence");
    expect(lastToolResult(api, 4)?.is_error).toBe(true);
    expect(lastToolResult(api, 5)?.is_error).toBeUndefined();
    expect(result.submission).toEqual(SUBMIT);
  });

  it("제출 없이 끝나면 submission 이 없다(앱이 실패로 처리)", async () => {
    const { run } = await setup([() => message([{ type: "text", text: "못 하겠다" }], "end_turn")]);
    expect((await run()).submission).toBeNull();
  });
});
