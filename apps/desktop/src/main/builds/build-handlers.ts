import type { IpcHandlers } from "@qa/shared";
import type { BuildService } from "./build-service";

type BuildChannel = "builds:list" | "builds:pickAndRegister" | "builds:runScript" | "builds:install";

export interface BuildPickers {
  /** main 의 파일 선택 창. 취소하면 null */
  pickArtifact(): Promise<string | null>;
  pickScript(): Promise<string | null>;
}

export function createBuildHandlers(builds: BuildService, pickers: BuildPickers): Pick<IpcHandlers, BuildChannel> {
  return {
    "builds:list": () => builds.list(),
    "builds:pickAndRegister": async ({ app }) => {
      const path = await pickers.pickArtifact();
      return path ? builds.registerPath(app, path) : null;
    },
    // 경로는 렌더러가 넘기지 않는다(CLAUDE.md 5장). 워크스페이스의 빌드 방법(T-110)은 main 안에서 넘긴다.
    "builds:runScript": async ({ app }) => {
      const path = await pickers.pickScript();
      return path ? builds.runScript(app, path) : null;
    },
    "builds:install": ({ buildId, deviceId }) => builds.install(buildId, deviceId),
  };
}
