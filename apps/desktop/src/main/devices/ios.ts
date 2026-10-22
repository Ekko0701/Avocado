/** simctl JSON 해석 (순수 함수, 단위 테스트 대상). ADR 0001 발견 1·2. */

export interface SimDeviceType {
  name: string;
  identifier: string;
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
  constructor(deviceType: string) {
    super(`'${deviceType}'을 지원하는 iOS 런타임이 없다. Xcode > Settings > Components 에서 런타임을 설치하거나 다른 기기 유형을 고른다`);
    this.name = "NoRuntimeError";
  }
}

function versionKey(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 기기 유형을 지원하는 가장 최신 iOS 런타임을 고른다.
 * 최신 런타임이 일반 기기를 지원하지 않을 수 있다(iOS 27.1 은 iPhone Duo 만 지원, ADR 0001 발견 1).
 */
export function pickRuntime(runtimes: SimRuntime[], deviceTypeName: string): { runtime: SimRuntime; deviceTypeId: string } {
  const candidates = runtimes
    .filter((r) => r.isAvailable !== false && (r.platform === "iOS" || r.name.startsWith("iOS")))
    .map((r) => ({ runtime: r, type: r.supportedDeviceTypes?.find((t) => t.name === deviceTypeName) }))
    .filter((c): c is { runtime: SimRuntime; type: SimDeviceType } => c.type !== undefined)
    .sort((a, b) => compareVersions(b.runtime.version, a.runtime.version));
  const best = candidates[0];
  if (!best) throw new NoRuntimeError(deviceTypeName);
  return { runtime: best.runtime, deviceTypeId: best.type.identifier };
}

/** simctl list devices -j 결과에서 이름으로 기기를 찾는다. */
export function findDeviceByName(
  devicesByRuntime: Record<string, SimDevice[]>,
  name: string,
): { device: SimDevice; runtimeId: string } | null {
  for (const [runtimeId, devices] of Object.entries(devicesByRuntime)) {
    const device = devices.find((d) => d.name === name && d.isAvailable !== false);
    if (device) return { device, runtimeId };
  }
  return null;
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
