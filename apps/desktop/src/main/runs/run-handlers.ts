import type { IpcHandlers } from "@qa/shared";
import type { RunService } from "./run-service";

type RunChannel = "runs:pickFlow" | "runs:start" | "runs:list" | "runs:get" | "runs:cancel" | "runs:setKeep";

export interface RunPickers {
  /** main 의 플로우 파일 선택 창. 취소하면 null */
  pickFlow(): Promise<string | null>;
}

export function createRunHandlers(runs: RunService, pickers: RunPickers): Pick<IpcHandlers, RunChannel> {
  return {
    "runs:pickFlow": async () => {
      const path = await pickers.pickFlow();
      if (!path) return null;
      const info = runs.allowFlow(path);
      return { path: info.path, name: info.name, appId: info.appId, tcId: info.tcId };
    },
    "runs:start": (input) => runs.start(input),
    "runs:list": () => runs.list(),
    "runs:get": ({ runId }) => runs.get(runId),
    "runs:cancel": ({ runId }) => runs.cancel(runId),
    "runs:setKeep": ({ runId, keep }) => runs.setKeep(runId, keep),
  };
}
