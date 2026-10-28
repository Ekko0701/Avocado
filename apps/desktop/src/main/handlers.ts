import type { IpcHandlers } from "@qa/shared";
import { app, shell } from "electron";
import { isAllowedExternalUrl } from "./security";
import type { UploadService } from "./evidence/upload-service";
import { createSettingsHandlers } from "./settings/settings-handlers";
import type { SettingsService } from "./settings/settings-service";
import type { AppDatabase } from "./db/database";
import { createSetupHandlers } from "./setup/setup-handlers";
import type { SetupService } from "./setup/setup-service";
import { createDeviceHandlers } from "./devices/device-handlers";
import type { DeviceService } from "./devices/device-service";
import { createBuildHandlers, type BuildPickers } from "./builds/build-handlers";
import type { BuildService } from "./builds/build-service";
import type { ProjectBuilds } from "./builds/project-builds";
import { createRunHandlers, type RunPickers } from "./runs/run-handlers";
import { createWorkspaceRunHandlers } from "./runs/workspace-run-handlers";
import type { RunQueue } from "./runs/run-queue";
import type { RunService } from "./runs/run-service";
import { createEvidenceHandlers } from "./evidence/evidence-handlers";
import type { EvidenceService } from "./evidence/evidence-service";
import type { RemoteProvider } from "@qa/remote";
import { createRemoteHandlers } from "./remote-handlers";
import { createWorkspaceHandlers } from "./workspace/workspace-handlers";
import type { WorkspaceService } from "./workspace/workspace-service";
import { createAgentHandlers } from "./agent/agent-handlers";
import type { AgentJobStore } from "./agent/agent-job-store";
import type { AuthorService } from "./agent/author-service";
import type { JudgeService } from "./agent/judge-service";
import type { ClaudeConnectService } from "./claude/claude-connect";
import { createUpdateHandlers } from "./update/update-handlers";
import type { UpdateService } from "./update/update-service";

export interface HandlerDeps {
  settings: SettingsService;
  db: AppDatabase;
  setup: SetupService;
  devices: DeviceService;
  builds: BuildService;
  buildPickers: BuildPickers;
  projectBuilds: ProjectBuilds;
  runs: RunService;
  runPickers: RunPickers;
  runQueue: RunQueue;
  evidence: EvidenceService;
  upload: UploadService;
  remote: RemoteProvider;
  workspace: WorkspaceService;
  agentJobs: AgentJobStore;
  author: AuthorService;
  judge: JudgeService;
  claude: ClaudeConnectService;
  update: UpdateService;
}

export function createHandlers(deps: HandlerDeps): IpcHandlers {
  return {
    "app:getInfo": () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
    "app:ping": ({ message }) => ({
      message,
      receivedAt: new Date().toISOString(),
    }),
    "app:openExternal": async ({ url }) => {
      if (!isAllowedExternalUrl(url)) throw new Error("허용하지 않는 외부 주소다(https://github.com 만)");
      // 검사한 것과 같은 정규화된 주소를 연다(원문 그대로 넘기면 OS 가 다르게 해석할 수 있다)
      const normalized = new URL(url).href;
      if (!isAllowedExternalUrl(normalized)) throw new Error("허용하지 않는 외부 주소다");
      await shell.openExternal(normalized);
      return { opened: true as const };
    },
    ...createSettingsHandlers(deps.settings),
    "db:status": () => deps.db.status(),
    ...createSetupHandlers(deps.setup, deps.settings),
    ...createDeviceHandlers(deps.devices),
    ...createBuildHandlers(deps.builds, deps.buildPickers, deps.projectBuilds),
    ...createRunHandlers(deps.runs, deps.runPickers),
    ...createWorkspaceRunHandlers({ workspace: deps.workspace, builds: deps.builds, queue: deps.runQueue }),
    ...createEvidenceHandlers(deps.evidence, deps.upload),
    ...createRemoteHandlers(deps.remote, () => deps.settings.getSettings().settings),
    ...createWorkspaceHandlers(deps.workspace),
    ...createAgentHandlers(deps.agentJobs, deps.author, deps.judge, () => deps.settings.getSettings().settings),
    "claude:status": () => deps.claude.status(),
    "claude:connectDesktop": () => deps.claude.connectDesktop(),
    ...createUpdateHandlers(deps.update),
  };
}
