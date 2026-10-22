import type { IpcHandlers } from "@qa/shared";
import type { UpdateService } from "./update-service";

export function createUpdateHandlers(update: UpdateService): Pick<IpcHandlers, "update:status" | "update:check" | "update:download"> {
  return {
    "update:status": () => update.status(),
    "update:check": () => update.check(),
    "update:download": () => update.download(),
  };
}
