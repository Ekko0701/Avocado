import type { IpcHandlers } from "@qa/shared";
import type { SettingsService } from "../settings/settings-service";
import type { SetupService } from "./setup-service";

type SetupChannel = "setup:check" | "setup:installTool" | "setup:progress" | "setup:verifyMaestro" | "setup:complete";

export class SetupNotReadyError extends Error {
  constructor(failed: string[]) {
    super(`필수 점검이 끝나지 않았다: ${failed.join(", ")}`);
    this.name = "SetupNotReadyError";
  }
}

export function createSetupHandlers(setup: SetupService, settings: SettingsService): Pick<IpcHandlers, SetupChannel> {
  return {
    "setup:check": () => setup.check(),
    "setup:installTool": ({ tool }) => setup.installTool(tool),
    "setup:progress": () => setup.progress(),
    "setup:verifyMaestro": () => setup.verifyMaestro(),
    "setup:complete": async () => {
      const report = await setup.check();
      const failed = report.checks.filter((c) => c.required && c.status !== "ok").map((c) => c.label);
      if (failed.length > 0) throw new SetupNotReadyError(failed);
      return settings.markSetupComplete();
    },
  };
}
