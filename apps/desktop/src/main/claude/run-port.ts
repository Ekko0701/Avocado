import { errorToMcpResult, toMcpResult, type McpToolDefinition, type McpToolResult } from "@qa/agent";
import {
  CancelRunsInputSchema,
  RunBatchSchema,
  RunOptionsSchema,
  RunsStatusInputSchema,
  StartRunsInputSchema,
  StartRunsResultSchema,
  type RunBatch,
  type RunOptions,
  type StartRunsInput,
} from "@qa/shared";
import { z } from "zod";
import type { McpConnection } from "../agent/author-service";
import type { AvocadoMcpPort } from "./mcp-server";
import { RunStartFailure, type RunOrigin } from "../runs/run-batch";

function jsonSchema(schema: z.ZodType): McpToolDefinition["inputSchema"] {
  const out: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete out["$schema"];
  return { ...out, type: "object" };
}

const RUN_TOOLS: McpToolDefinition[] = [
  {
    name: "run_options",
    description: "Avocado 에서 실행할 수 있는 것: 워크스페이스의 앱·테스트 케이스(플로우가 있는 타깃), 준비된 기기, 등록한 빌드. 모델을 부르지 않는다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_runs",
    description:
      "테스트 케이스의 플로우를 기기에서 차례로 재생하는 실행 묶음을 시작한다. tcIds 나 tag 중 하나를 준다. 기기를 빼면 준비된 기기가 하나일 때만 그 기기를 쓴다. 결과는 { batch } 또는 { error: { code, message } }.",
    inputSchema: jsonSchema(StartRunsInputSchema),
  },
  {
    name: "runs_status",
    description: "실행 묶음 하나의 상태. waitSeconds(0~45)를 주면 상태가 바뀌거나 시간이 지날 때까지 기다렸다가 돌려준다.",
    inputSchema: jsonSchema(RunsStatusInputSchema),
  },
  { name: "cancel_runs", description: "실행 묶음 하나를 취소한다. 다른 묶음은 건드리지 않는다.", inputSchema: jsonSchema(CancelRunsInputSchema) },
];

export const RUN_TOOL_NAMES = new Set(RUN_TOOLS.map((t) => t.name));

const json = (value: unknown, isError = false): McpToolResult => toMcpResult(JSON.stringify(value), isError);

/**
 * 밖에서 붙은 MCP 클라이언트(avocado CLI 등)가 실행을 시작·조회·취소하는 포트(ADR 0035 결정 2·8).
 * 판단(기기 고르기, 플로우 찾기)은 start(startRunBatch)가 한다. 여기서는 입력 검사, 묶음 id 확인, 연결 거절만 한다
 */
export function createRunPort(deps: {
  start(input: StartRunsInput, origin: RunOrigin): Promise<RunBatch>;
  options(): Promise<RunOptions>;
  queue: {
    batch(id: string): RunBatch | null;
    waitForChange(id: string, ms: number): Promise<RunBatch | null>;
    cancel(id: string): RunBatch | null;
  };
  /** 이 연결이 플로우 만들기·화면 판정 작업을 맡고 있나 */
  holdsJob(connectionId: string): boolean;
}): AvocadoMcpPort {
  const found = (batch: RunBatch | null, id: string): McpToolResult =>
    batch ? json(RunBatchSchema.parse(batch)) : json({ error: { code: "unknown_batch", message: `실행 묶음을 찾지 못했다: ${id}. 앱이 다시 켜졌으면 결과 화면에서 본다` } }, true);
  const refuseHolder = (connection: McpConnection): McpToolResult | null =>
    deps.holdsJob(connection.id)
      ? json(StartRunsResultSchema.parse({ error: { code: "caller_busy", message: "이 연결은 플로우 만들기나 화면 판정을 맡고 있다. 기기 화면을 읽는 연결은 실행을 시작·취소하지 못한다" } }), true)
      : null;
  return {
    tools: () => RUN_TOOLS,
    async call(connection, name, args) {
      try {
        if (name === "run_options") return json(RunOptionsSchema.parse(await deps.options()));
        if (name === "start_runs") {
          const input = StartRunsInputSchema.parse(args ?? {});
          const refused = refuseHolder(connection);
          if (refused) return refused;
          try {
            // 클라이언트 이름은 밖에서 정한 글자다. 화면과 기록에 보이므로 길이를 자른다
            const batch = await deps.start(input, { via: "mcp", client: (connection.client || "mcp").slice(0, 80) });
            return json(StartRunsResultSchema.parse({ batch }));
          } catch (error) {
            if (!(error instanceof RunStartFailure)) throw error;
            return json(StartRunsResultSchema.parse({ error: { code: error.code, message: error.message, ...(error.candidates ? { candidates: error.candidates } : {}) } }), true);
          }
        }
        if (name === "runs_status") {
          const input = RunsStatusInputSchema.parse(args ?? {});
          return found(await deps.queue.waitForChange(input.batchId, (input.waitSeconds ?? 0) * 1000), input.batchId);
        }
        if (name === "cancel_runs") {
          const input = CancelRunsInputSchema.parse(args ?? {});
          const refused = refuseHolder(connection);
          if (refused) return refused;
          return found(deps.queue.cancel(input.batchId), input.batchId);
        }
        return json({ error: { code: "unknown_tool", message: `모르는 도구다: ${name}` } }, true);
      } catch (error) {
        return errorToMcpResult(error, (t) => t);
      }
    },
  };
}
