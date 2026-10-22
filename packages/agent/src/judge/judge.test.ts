import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_PNG_BASE64 } from "../../test-support/fake-maestro-mcp";
import { message, startFakeMessagesApi, type FakeMessagesApi, type FakeReply } from "../../test-support/fake-messages-api";
import { AuditLog } from "../audit";
import { Budget, BudgetExceededError, MODE_LIMITS } from "../budget";
import { AgentRefusalError } from "../run-loop";
import { JudgeOutputError, judgeCapture } from "./judge";

let api: FakeMessagesApi | null = null;
afterEach(async () => {
  await api?.close();
  api = null;
});

async function judge(reply: FakeReply, limits = MODE_LIMITS.judge) {
  api = await startFakeMessagesApi([reply]);
  const client = new Anthropic({ apiKey: "test-not-a-real-key", baseURL: api.url, maxRetries: 0 });
  const budget = new Budget(limits, { monthlyRemainingUsd: 10 });
  const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), "qa-judge-")), "a.jsonl"), { jobId: "judge", secrets: [] });
  return judgeCapture({
    client,
    image: { data: Buffer.from(FAKE_PNG_BASE64, "base64"), mimeType: "image/png" },
    expectation: "회원가입 화면이 열리고 '가입하기' 버튼이 보인다",
    context: { tcId: "TC-0101", step: "takeScreenshot 01_signup_form" },
    budget,
    audit,
  });
}
const json = (o: unknown) => () => message([{ type: "text", text: JSON.stringify(o) }], "end_turn", { input: 1500, output: 120 });

describe("judgeCapture (가짜 API)", () => {
  it("캡처와 기대 결과로 한 번 호출하고 구조화 결과를 돌려준다. effort low, 서버 측 폴백", async () => {
    const r = await judge(json({ blankScreen: false, verdict: "pass", defects: [], confidence: 0.9, reason: "가입하기 버튼이 보인다" }));
    expect(r).toMatchObject({ verdict: "pass", defects: [], confidence: 0.9, model: "claude-opus-5-5" });
    const req = api?.requests[0];
    expect(req?.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(req?.["fallbacks"]).toBe("default");
    expect(req?.tools).toBeUndefined();
    expect(req?.tool_choice).toBeUndefined();
    expect(JSON.stringify(req?.messages)).toContain('"type":"image"');
    expect(JSON.stringify(req?.system)).toContain("빈 화면");
  });

  it("빈 화면이면 결과를 fail 로 맞추고 blank_screen 을 넣는다", async () => {
    const r = await judge(json({ blankScreen: true, verdict: "pass", defects: [], confidence: 0.7, reason: "흰 화면" }));
    expect(r.verdict).toBe("fail");
    expect(r.defects[0]?.type).toBe("blank_screen");
  });

  it("형식이 틀리거나 범위를 벗어나면 통과로 바꾸지 않고 오류", async () => {
    await expect(judge(json({ verdict: "pass" }))).rejects.toThrow(JudgeOutputError);
    await expect(judge(() => message([{ type: "text", text: "{\"blankScreen\": fal" }], "max_tokens"))).rejects.toThrow("잘렸다");
    await expect(judge(json({ blankScreen: false, verdict: "pass", defects: [], confidence: 3, reason: "x" }))).rejects.toThrow(JudgeOutputError);
  });

  it("거절은 AgentRefusalError(거절 문구가 JSON 이 아니어도 사용량은 먼저 기록), 비용 상한을 넘으면 BudgetExceededError", async () => {
    await expect(judge(() => message([{ type: "text", text: "이 요청은 도울 수 없다" }], "refusal"))).rejects.toThrow(AgentRefusalError);
    await expect(judge(json({ blankScreen: false, verdict: "pass", defects: [], confidence: 0.5, reason: "x" }), { ...MODE_LIMITS.judge, maxCostUsd: 0.000001 })).rejects.toThrow(BudgetExceededError);
  });
});
