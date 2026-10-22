import type Anthropic from "@anthropic-ai/sdk";
import type { AuditLog } from "../audit";
import type { Budget } from "../budget";
import type { BridgeTool } from "../mcp-bridge";
import { runToolLoop, type Effort } from "../run-loop";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";
import { AUTHOR_SYSTEM_PROMPT, authorUserMessage, type AuthorInput } from "./prompt";
import { AuthorSession, type AuthorEvent, type SubmitFlow } from "./tools";

export interface RunAuthorOptions {
  client: Anthropic;
  model?: string;
  /** PLAN 8장: author 는 high */
  effort?: Effort;
  input: AuthorInput;
  /** McpBridge.tools() (maestro mcp 허용 목록) */
  deviceTools: BridgeTool[];
  budget: Budget;
  audit: AuditLog;
  signal?: AbortSignal;
  onEvent?: (event: AuthorEvent) => void;
  onMessage?: (message: BetaMessage) => void;
}

export interface AuthorResult {
  /** submit_flow 로 받은 결과. 제출 없이 끝나면 null */
  submission: SubmitFlow | null;
  questions: string[];
  stopReason: string | null;
  iterations: number;
}

/** author 한 번(PLAN 6.5 3~6의 탐색·제출). 검증·재생·커밋은 앱(AuthorService)이 한다 */
export async function runAuthor(options: RunAuthorOptions): Promise<AuthorResult> {
  const session = new AuthorSession(options.input.tc.steps, options.budget, options.onEvent);
  const result = await runToolLoop({
    client: options.client,
    model: options.model,
    effort: options.effort ?? "high",
    system: AUTHOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: authorUserMessage(options.input) }],
    tools: [...options.deviceTools, ...session.tools()],
    budget: options.budget,
    audit: options.audit,
    maxTokens: 16_000,
    signal: options.signal,
    onMessage: (message) => {
      for (const block of message.content) if (block.type === "tool_use") options.onEvent?.({ type: "tool", name: block.name });
      options.onMessage?.(message);
    },
  });
  return { submission: session.submission, questions: [...session.questions], stopReason: result.final.stop_reason, iterations: result.iterations };
}
