import type { IpcHandlers } from "@qa/shared";
import type { BuildService } from "./build-service";
import type { ProjectBuilds } from "./project-builds";

type BuildChannel =
  | "builds:list"
  | "builds:pickAndRegister"
  | "builds:runScript"
  | "builds:install"
  | "builds:projectStatus"
  | "builds:linkProject"
  | "builds:unlinkProject"
  | "builds:buildProject"
  | "builds:activity"
  | "builds:cancel";

export interface BuildPickers {
  /** main 의 파일 선택 창. 취소하면 null */
  pickArtifact(): Promise<string | null>;
  pickScript(): Promise<string | null>;
  /** 프로젝트 폴더 또는 .xcworkspace·.xcodeproj */
  pickProject(): Promise<string | null>;
}

export function createBuildHandlers(builds: BuildService, pickers: BuildPickers, projects: ProjectBuilds): Pick<IpcHandlers, BuildChannel> {
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
    // 프로젝트 경로도 렌더러가 넘기지 않는다. main 의 선택 창으로 고르고 각자 설정에 둔다(ADR 0025)
    "builds:projectStatus": ({ app, prepare }) => projects.status(app, { prepare }),
    "builds:linkProject": async ({ app }) => {
      const path = await pickers.pickProject();
      return path ? projects.link(app, path) : null;
    },
    "builds:unlinkProject": ({ app }) => projects.unlink(app),
    "builds:buildProject": ({ app, scheme, configuration }) => projects.build(app, scheme, configuration),
    "builds:activity": () => builds.activity(),
    "builds:cancel": () => builds.cancel(),
  };
}
