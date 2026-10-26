import type { IpcHandlers } from "@qa/shared";
import type { DeviceService } from "./device-service";

type DeviceChannel = "devices:list" | "devices:prepareIos" | "devices:prepareAndroid" | "devices:shutdown" | "devices:iosOptions" | "devices:deleteIos";

export function createDeviceHandlers(devices: DeviceService): Pick<IpcHandlers, DeviceChannel> {
  return {
    "devices:list": () => devices.list(),
    "devices:prepareIos": (input) => devices.prepareIos(input),
    "devices:prepareAndroid": (input) => devices.prepareAndroid(input),
    "devices:shutdown": (ref) => devices.shutdown(ref),
    "devices:iosOptions": () => devices.iosOptions(),
    "devices:deleteIos": (input) => devices.deleteIos(input),
  };
}
