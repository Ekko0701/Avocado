import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaTool, BetaToolResultContentBlockParam } from "@anthropic-ai/sdk/resources/beta";
import { ZodError } from "zod";
import { BudgetExceededError } from "./budget";

/**
 * Avocado 도구를 사용자의 Claude 앱에 MCP 도구로 내보낼 때 쓰는 변환(ADR 0022).
 * 도구 실행 결과(SDK 도구 실행기 형식)를 MCP CallTool 결과로 바꾼다.
 */

/** MCP tools/list 항목 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/** MCP tools/call 결과 중 Avocado 가 내는 형태 */
export interface McpToolResult {
  [key: string]: unknown;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export type ToolOutput = string | BetaToolResultContentBlockParam[];
export type ToolHandler = (args: unknown, signal?: AbortSignal) => Promise<ToolOutput>;

export function toolDefinition(tool: Pick<BetaTool, "name" | "description" | "input_schema">): McpToolDefinition {
  return { name: tool.name, description: tool.description ?? "", inputSchema: { ...tool.input_schema, type: "object" } };
}

/** SDK 도구(betaZodTool 등)를 MCP 핸들러로. 입력은 도구의 parse(스키마 검사)를 거친 뒤 실행한다 */
// 도구마다 입력 타입이 달라 SDK 처럼 any 로 받는다
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runnableHandler(tool: BetaRunnableTool<any>): ToolHandler {
  return async (args) => tool.run(tool.parse(args));
}

export function toMcpResult(output: ToolOutput, isError = false): McpToolResult {
  const blocks = typeof output === "string" ? [{ type: "text" as const, text: output }] : output;
  const content: McpToolResult["content"] = blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image" && block.source.type === "base64") return { type: "image", data: block.source.data, mimeType: block.source.media_type };
    // 지금 도구들은 글자·base64 이미지만 낸다. 다른 형식이 생기면 조용히 버리지 않고 알 수 있게 남긴다
    return { type: "text", text: `[보낼 수 없는 결과 형식: ${block.type}]` };
  });
  return isError ? { content, isError: true } : { content };
}

/**
 * 도구 오류를 MCP 오류 결과로. 모델이 고칠 수 있게 이유를 돌려준다.
 * redact 는 오류 문장에 남을 수 있는 비밀 값을 가린다.
 */
export function errorToMcpResult(error: unknown, redact: (text: string) => string): McpToolResult {
  if (error instanceof ToolError) {
    return typeof error.content === "string" ? toMcpResult(redact(error.content), true) : toMcpResult(redactBlocks(error.content, redact), true);
  }
  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => `${i.path.join(".") || "(입력)"}: ${i.message}`).join(" / ");
    return toMcpResult(redact(`입력 형식이 맞지 않다: ${issues}`), true);
  }
  if (error instanceof BudgetExceededError) return toMcpResult(redact(`작업 상한에 닿아 끝났다: ${error.message}`), true);
  return toMcpResult(redact(error instanceof Error ? error.message : String(error)), true);
}

function redactBlocks(blocks: BetaToolResultContentBlockParam[], redact: (text: string) => string): BetaToolResultContentBlockParam[] {
  return blocks.map((b) => (b.type === "text" ? { ...b, text: redact(b.text) } : b));
}
