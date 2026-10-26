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

/** 기기 화면에서 고를 수 있는 iOS 시뮬레이터 조합: 이 Mac 의 iOS 런타임(최신 먼저)과 각 런타임이 지원하는 iPhone·iPad */
export const IosDeviceOptionsSchema = z.strictObject({
  runtimes: z.array(
    z.strictObject({
      /** com.apple.CoreSimulator.SimRuntime.iOS-27-0 */
      id: z.string(),
      version: z.string(),
      deviceTypes: z.array(z.strictObject({ name: z.string(), family: z.enum(["iPhone", "iPad"]) })),
    }),
  ),
  /** 고르지 않으면 쓰는 기종 */
  defaultDeviceType: z.string(),
});
export type IosDeviceOptions = z.infer<typeof IosDeviceOptionsSchema>;

export const IosRuntimeIdSchema = z.string().regex(/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9]+(-[0-9]+){0,2}$/, "iOS 런타임 id 형식이 아니다");
/** deviceType·runtime 을 비우면 기본 기종을, 이미 있는 앱 기기(가장 새 iOS) 또는 그 기종을 지원하는 최신 iOS 로 준비한다 */
export const PrepareIosInputSchema = z.strictObject({ deviceType: z.string().min(1).max(64).optional(), runtime: IosRuntimeIdSchema.optional() });
/** 앱이 만든 iOS 시뮬레이터 지우기(UDID) */
export const DeleteIosInputSchema = z.strictObject({ id: z.string().regex(/^[0-9A-F-]{36}$/i, "시뮬레이터 UDID 형식이 아니다") });
export const PrepareAndroidInputSchema = z.strictObject({ avd: z.string().regex(/^[A-Za-z0-9._-]+$/).optional() });
export const DeviceRefSchema = z.strictObject({ platform: z.enum(["ios", "android"]), id: z.string().min(1).max(128) });
