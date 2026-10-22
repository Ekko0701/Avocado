import type { Build, IpcHandlers } from "@qa/shared";
import type { RunQueue } from "./run-queue";

export function createWorkspaceRunHandlers(deps: {
  workspace: { flowsToRun(input: { app: string; target: "ios" | "android"; tcId?: string; tag?: string }): { appId: string | null; flows: { tcId: string; path: string }[] } };
  builds: { get(id: string): Build };
  queue: RunQueue;
}): Pick<IpcHandlers, "runs:startFromWorkspace" | "runs:queue" | "runs:clearQueue"> {
  return {
    "runs:startFromWorkspace": (input) => {
      const { appId, flows } = deps.workspace.flowsToRun({ app: input.app, target: input.target, tcId: input.tcId, tag: input.tag });
      const build = input.buildId ? deps.builds.get(input.buildId) : null;
      if (build && (build.app !== input.app || build.target !== input.target)) throw new Error(`빌드가 ${input.app} ${input.target} 용이 아니다`);
      // 빌드는 모든 실행에 기록하고(증적에 어떤 빌드인지 남는다) 설치는 첫 실행에서만 한다.
      // 빌드가 없으면 app.yaml 의 앱 id 로 기기에 설치된 앱을 돌린다
      deps.queue.enqueue(
        flows.map((f, i) => ({
          label: f.tcId,
          input: { app: input.app, flowPath: f.path, deviceId: input.deviceId, buildId: input.buildId },
          options: build ? { skipInstall: i > 0 } : appId ? { appId } : {},
        })),
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
