import type { IpcHandlers } from "@qa/shared";
import { startRunBatch, type RunBatchDeps } from "./run-batch";

/** 실행 화면의 테스트 케이스·태그 실행. 밖의 MCP 클라이언트와 같은 입구(startRunBatch)를 쓴다(ADR 0035 결정 2) */
export function createWorkspaceRunHandlers(deps: RunBatchDeps): Pick<IpcHandlers, "runs:startFromWorkspace" | "runs:queue" | "runs:clearQueue"> {
  return {
    "runs:startFromWorkspace": async (input) => {
      await startRunBatch(
        deps,
        { app: input.app, target: input.target, ...(input.tcId ? { tcIds: [input.tcId] } : { tag: input.tag ?? "" }), deviceId: input.deviceId, ...(input.buildId ? { buildId: input.buildId } : {}) },
        { via: "app" },
      );
      return deps.queue.status();
    },
    "runs:queue": () => deps.queue.status(),
    "runs:clearQueue": () => {
      deps.queue.clear();
      return deps.queue.status();
    },
  };
}
