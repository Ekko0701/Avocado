import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuthorSession } from "./author/tools";
import { BudgetExceededError } from "./budget";
import { McpBridge } from "./mcp-bridge";
import { errorToMcpResult, runnableHandler, toMcpResult, toolDefinition } from "./mcp-export";
import { MAESTRO_AUTHOR_TOOL_DESCRIPTIONS, MAESTRO_POLICY } from "./policy";

const SECRET = "fixture-Pw#2026-export";
const redact = (text: string) => text.replaceAll(SECRET, "[REDACTED]");

describe("MCP 내보내기(Claude 앱 방식, ADR 0022)", () => {
  it("도구 결과(글자·base64 이미지)를 MCP 결과로 바꾼다", () => {
    expect(toMcpResult("화면")).toEqual({ content: [{ type: "text", text: "화면" }] });
    expect(
      toMcpResult([
        { type: "text", text: "a" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ]),
    ).toEqual({ content: [{ type: "text", text: "a" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    expect(toMcpResult("실패", true)).toEqual({ content: [{ type: "text", text: "실패" }], isError: true });
  });

  it("오류는 이유를 담은 isError 결과로, 비밀 값은 가린다", () => {
    expect(errorToMcpResult(new ToolError(`거부됨: ${SECRET}`), redact)).toEqual({ content: [{ type: "text", text: "거부됨: [REDACTED]" }], isError: true });
    expect(errorToMcpResult(new ToolError([{ type: "text", text: SECRET }]), redact).content).toEqual([{ type: "text", text: "[REDACTED]" }]);
    const zod = z.strictObject({ step: z.number() }).safeParse({ step: "x" });
    expect(zod.success).toBe(false);
    if (!zod.success) expect(errorToMcpResult(zod.error, redact).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("입력 형식이 맞지 않다: step") });
    expect(errorToMcpResult(new BudgetExceededError("tool_calls", "도구 호출 상한"), redact).content[0]).toMatchObject({ text: expect.stringContaining("작업 상한에 닿아") });
    expect(errorToMcpResult(new Error(`실패 ${SECRET}`), redact)).toEqual({ content: [{ type: "text", text: "실패 [REDACTED]" }], isError: true });
  });

  it("SDK 도구는 스키마 검사(parse)를 거친 뒤 실행한다", async () => {
    const tool = betaZodTool({ name: "echo", description: "", inputSchema: z.strictObject({ n: z.number() }), run: ({ n }) => `n=${n}` });
    const handler = runnableHandler(tool);
    expect(await handler({ n: 2 })).toBe("n=2");
    await expect(handler({ n: "2" })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("작업 전에도 같은 도구 목록을 줄 수 있다: maestro 도구는 기기 인자 없이, author 도구는 같은 스키마로", () => {
    const device = McpBridge.toolDefinitions("maestro", MAESTRO_POLICY.author, MAESTRO_AUTHOR_TOOL_DESCRIPTIONS);
    expect(device.map((d) => d.name)).toEqual(["maestro_inspect_screen", "maestro_take_screenshot", "maestro_run", "maestro_cheat_sheet"]);
    const run = device.find((d) => d.name === "maestro_run");
    expect(run?.inputSchema).toEqual({ type: "object", properties: { yaml: { type: "string" } }, required: ["yaml"], additionalProperties: false });
    expect(run?.description).toContain("<screen_data>");
    expect(device.find((d) => d.name === "maestro_inspect_screen")?.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });

    const session = AuthorSession.toolSpecs().map(toolDefinition);
    expect(session.map((d) => d.name)).toEqual(["begin_step", "ask_planner", "submit_flow"]);
    expect(session.find((d) => d.name === "submit_flow")?.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["yaml", "confidence"]) });
  });
});
