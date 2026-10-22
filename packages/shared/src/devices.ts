import { z } from "zod";

/** QA 기기 (PLAN 3.2 DeviceService, T-104). */
export const DeviceSchema = z.strictObject({
  /** iOS 는 UDID, Android 는 AVD 이름 */
  id: z.string(),
  platform: z.enum(["ios", "android"]),
  kind: z.enum(["simulator", "emulator"]),
  name: z.string(),
  osVersion: z.string(),
  state: z.enum(["booted", "shutdown", "booting", "unknown"]),
  /** 앱이 만든 QA 전용 기기인지 */
  managed: z.boolean(),
  /** Android 실행 중일 때의 adb serial */
  serial: z.string().nullable(),
  /** 확인한 기기 언어. 모르면 null */
  locale: z.string().nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceListSchema = z.strictObject({
  devices: z.array(DeviceSchema),
  /** Android SDK(emulator, adb)를 찾았는지 */
  androidAvailable: z.boolean(),
});
export type DeviceList = z.infer<typeof DeviceListSchema>;

export const PrepareIosInputSchema = z.strictObject({ deviceType: z.string().min(1).max(64).optional() });
export const PrepareAndroidInputSchema = z.strictObject({ avd: z.string().regex(/^[A-Za-z0-9._-]+$/).optional() });
export const DeviceRefSchema = z.strictObject({ platform: z.enum(["ios", "android"]), id: z.string().min(1).max(128) });
