import type { IpcHandlers } from "@qa/shared";
import type { SettingsService } from "./settings-service";

type SettingsChannel = "settings:get" | "settings:update" | "secrets:list" | "secrets:set" | "secrets:delete";

/** electron 을 import 하지 않아 단위 테스트할 수 있다. 비밀 값을 돌려주는 핸들러는 없다. */
export function createSettingsHandlers(service: SettingsService): Pick<IpcHandlers, SettingsChannel> {
  return {
    "settings:get": () => service.getSettings(),
    "settings:update": (patch) => service.updateSettings(patch),
    "secrets:list": () => service.listSecrets(),
    "secrets:set": ({ name, value }) => service.setSecret(name, value),
    "secrets:delete": ({ name }) => service.deleteSecret(name),
  };
}
