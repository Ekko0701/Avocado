/** simctl JSON 해석 (순수 함수, 단위 테스트 대상). ADR 0001 발견 1·2. */

export interface SimDeviceType {
  name: string;
  identifier: string;
  /** iPhone, iPad, Apple TV … */
  productFamily?: string;
}
export interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  isAvailable?: boolean;
  platform?: string;
  supportedDeviceTypes?: SimDeviceType[];
}
export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

export class NoRuntimeError extends Error {
  constructor(deviceType: string, reason?: string) {
    super(
      reason
        ? `${reason}. Xcode > Settings > Components 에서 런타임을 설치하거나 다른 iOS 버전·기종을 고른다`
        : `'${deviceType}'을 지원하는 iOS 런타임이 없다. Xcode > Settings > Components 에서 런타임을 설치하거나 다른 기기 유형을 고른다`,
    );
    this.name = "NoRuntimeError";
  }
}

function versionKey(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 쓸 수 있는 iOS 런타임(최신 먼저) */
function iosRuntimes(runtimes: SimRuntime[]): SimRuntime[] {
  return runtimes
    .filter((r) => r.isAvailable !== false && (r.platform === "iOS" || r.name.startsWith("iOS")))
    .sort((a, b) => compareVersions(b.version, a.version));
}

function familyOf(t: SimDeviceType): "iPhone" | "iPad" | null {
  const family = t.productFamily ?? (t.name.startsWith("iPad") ? "iPad" : t.name.startsWith("iPhone") ? "iPhone" : null);
  return family === "iPhone" || family === "iPad" ? family : null;
}

/** 기기 화면에서 고를 수 있는 조합: iOS 런타임(최신 먼저)마다 지원하는 iPhone·iPad(simctl 순서). iPhone·iPad 가 없는 런타임은 뺀다 */
export function iosDeviceChoices(runtimes: SimRuntime[]): { id: string; version: string; deviceTypes: { name: string; family: "iPhone" | "iPad" }[] }[] {
  return iosRuntimes(runtimes)
    .map((r) => ({
      id: r.identifier,
      version: r.version,
      deviceTypes: (r.supportedDeviceTypes ?? []).flatMap((t) => {
        const family = familyOf(t);
        return family ? [{ name: t.name, family }] : [];
      }),
    }))
    .filter((r) => r.deviceTypes.length > 0);
}

/**
 * 기기 유형을 지원하는 iOS 런타임을 고른다. runtimeId 를 주면 그 런타임이 지원해야 하고, 없으면 가장 최신 런타임.
 * 최신 런타임이 일반 기기를 지원하지 않을 수 있다(iOS 27.1 은 iPhone Duo 만 지원, ADR 0001 발견 1).
 */
export function pickRuntime(runtimes: SimRuntime[], deviceTypeName: string, runtimeId?: string): { runtime: SimRuntime; deviceTypeId: string } {
  const available = iosRuntimes(runtimes);
  if (runtimeId) {
    const runtime = available.find((r) => r.identifier === runtimeId);
    if (!runtime) throw new NoRuntimeError(deviceTypeName, `${iosVersionFromRuntimeId(runtimeId)} 런타임이 이 Mac 에 없다`);
    const type = runtime.supportedDeviceTypes?.find((t) => t.name === deviceTypeName);
    if (!type) throw new NoRuntimeError(deviceTypeName, `iOS ${runtime.version} 은 '${deviceTypeName}' 을 지원하지 않는다`);
    return { runtime, deviceTypeId: type.identifier };
  }
  for (const runtime of available) {
    const type = runtime.supportedDeviceTypes?.find((t) => t.name === deviceTypeName);
    if (type) return { runtime, deviceTypeId: type.identifier };
  }
  throw new NoRuntimeError(deviceTypeName);
}

/**
 * 조건에 맞는 기기 중 가장 새 iOS 런타임의 것을 찾는다(사용할 수 없는 기기는 뺀다).
 * 같은 기종의 앱 기기가 여러 iOS 버전으로 있을 때 기본 준비가 가장 새 것을 다시 쓰게 한다
 */
export function findNewestDevice(
  devicesByRuntime: Record<string, SimDevice[]>,
  match: (device: SimDevice, runtimeId: string) => boolean,
): { device: SimDevice; runtimeId: string } | null {
  let best: { device: SimDevice; runtimeId: string } | null = null;
  for (const [runtimeId, devices] of Object.entries(devicesByRuntime)) {
    for (const device of devices) {
      if (device.isAvailable === false || !match(device, runtimeId)) continue;
      if (!best || compareVersions(iosVersionFromRuntimeId(runtimeId), iosVersionFromRuntimeId(best.runtimeId)) > 0) best = { device, runtimeId };
    }
  }
  return best;
}

/** com.apple.CoreSimulator.SimRuntime.iOS-27-0 → 27.0 */
export function iosVersionFromRuntimeId(runtimeId: string): string {
  const m = /iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtimeId);
  return m ? [m[1], m[2], m[3]].filter(Boolean).join(".") : runtimeId;
}

/** 설정 언어(ko_KR) → iOS 전역 설정 값 */
export function appleLocaleValues(locale: string): { appleLocale: string; appleLanguage: string } {
  const [lang, region] = locale.split("_");
  return { appleLocale: locale, appleLanguage: region ? `${lang}-${region}` : `${lang}` };
}

export function simState(state: string): "booted" | "shutdown" | "booting" | "unknown" {
  const s = state.toLowerCase();
  if (s === "booted") return "booted";
  if (s === "shutdown") return "shutdown";
  if (s === "booting") return "booting";
  return "unknown";
}
