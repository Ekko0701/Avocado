import { z } from "zod";

/** QA 기기 (PLAN 3.2 DeviceService, T-104). */
export const DeviceSchema = z.strictObject({
  /** iOS 는 UDID(실기기는 하드웨어 UDID), Android 에뮬레이터는 AVD 이름, Android 실기기는 adb serial */
  id: z.string(),
  platform: z.enum(["ios", "android"]),
  /** real: USB·무선 디버깅으로 연결한 Android 폰(ADR 0030), 케이블·네트워크로 연결한 iPhone·iPad(ADR 0034) */
  kind: z.enum(["simulator", "emulator", "real"]),
  name: z.string(),
  osVersion: z.string(),
  state: z.enum(["booted", "shutdown", "booting", "unknown"]),
  /** 앱이 만든 QA 전용 기기인지 */
  managed: z.boolean(),
  /** Android 실행 중(실기기는 연결됨)일 때의 adb serial */
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

/** Apple 개발 팀 ID (인증서 OU) */
export const AppleTeamIdSchema = z.string().regex(/^[A-Z0-9]{10}$/, "Apple 팀 ID 형식이 아니다");
/** iOS 실기기 러너를 서명할 수 있는 팀: 이 Mac 키체인의 Apple Development 인증서에서 읽는다(ADR 0034) */
export const IosSigningTeamSchema = z.strictObject({ id: AppleTeamIdSchema, name: z.string() });
export type IosSigningTeam = z.infer<typeof IosSigningTeamSchema>;
export const IosSigningTeamsSchema = z.array(IosSigningTeamSchema);

/** iOS 실기기 준비 점검 하나 */
export const IosDeviceCheckSchema = z.strictObject({
  id: z.enum(["connected", "developerMode", "devToolsSecurity", "unlocked", "signingTeam", "tool", "runner"]),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type IosDeviceCheck = z.infer<typeof IosDeviceCheckSchema>;
export const IosDeviceReadinessSchema = z.strictObject({
  deviceId: z.string(),
  checks: z.array(IosDeviceCheckSchema),
  ready: z.boolean(),
});
export type IosDeviceReadiness = z.infer<typeof IosDeviceReadinessSchema>;
/** iPhone·iPad 하드웨어 UDID(00008160-001C79811EA80036, 예전 기기는 40자리 16진수) */
export const IosPhysicalIdSchema = z.string().regex(/^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40})$/i, "iPhone UDID 형식이 아니다");
/** buildRunner: 점검 뒤 러너를 서명·빌드해 기기에 올린다(처음 한 번, 몇 분) */
export const IosDeviceInputSchema = z.strictObject({ id: IosPhysicalIdSchema, buildRunner: z.boolean().default(false) });
