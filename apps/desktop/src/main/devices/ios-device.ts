/** iOS 실기기(iPhone·iPad) 해석. devicectl JSON·키체인 인증서를 읽는 순수 함수(ADR 0034, 단위 테스트 대상) */
import type { Device, IosSigningTeam } from "@qa/shared";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

/** devicectl list devices --json-output 에서 쓰는 칸만 */
const DevicectlDeviceSchema = z.object({
  hardwareProperties: z
    .object({
      udid: z.string().optional(),
      platform: z.string().optional(),
      reality: z.string().nullable().optional(),
      deviceType: z.string().optional(),
      marketingName: z.string().nullable().optional(),
    })
    .optional(),
  deviceProperties: z
    .object({
      name: z.string().optional(),
      osVersionNumber: z.string().nullable().optional(),
      developerModeStatus: z.string().nullable().optional(),
    })
    .optional(),
  connectionProperties: z
    .object({
      pairingState: z.string().optional(),
      tunnelState: z.string().optional(),
      transportType: z.string().nullable().optional(),
    })
    .optional(),
});
const DevicectlListSchema = z.object({
  info: z.object({ outcome: z.string() }),
  result: z.object({ devices: z.array(DevicectlDeviceSchema) }),
});

export interface PhysicalIosDevice {
  device: Device;
  /** 기기의 개발자 모드. 모르면 null */
  developerMode: boolean | null;
  paired: boolean;
  connected: boolean;
}

/**
 * devicectl 기기 목록에서 연결된 실제 iPhone·iPad 를 뽑는다. 시뮬레이터·Apple Watch 는 뺀다.
 * 짝지어 있고(paired) 닿을 수 있으며 개발자 모드가 켜져 있어야 booted(쓸 수 있음)다. 아니면 unknown 으로 두어 실행이 거부되게 한다.
 * 닿을 수 있음: 터널이 열려 있거나(connected), 케이블로 꽂혀 있는데 터널만 쉬는 중(disconnected + wired)이다.
 * macOS 는 누가 기기에 물을 때 터널을 연다(devicectl device info 등). 케이블을 막 꽂은 기기는 disconnected 로 보인다.
 * 무선으로만 보이는 기기(localNetwork)는 케이블로 연결하라고 안내한다
 * 형식이 다르면 예외를 낸다(빈 목록으로 바꾸지 않는다)
 */
export function parseDevicectlDevices(json: unknown): PhysicalIosDevice[] {
  const parsed = DevicectlListSchema.parse(json);
  if (parsed.info.outcome !== "success") throw new Error(`devicectl 결과가 실패다: ${parsed.info.outcome}`);
  const out: PhysicalIosDevice[] = [];
  for (const d of parsed.result.devices) {
    const hw = d.hardwareProperties ?? {};
    if (hw.reality !== "physical" || hw.platform !== "iOS" || !hw.udid) continue;
    if (hw.deviceType !== "iPhone" && hw.deviceType !== "iPad") continue;
    const paired = d.connectionProperties?.pairingState === "paired";
    const tunnel = d.connectionProperties?.tunnelState;
    const connected = tunnel === "connected" || (tunnel === "disconnected" && d.connectionProperties?.transportType === "wired");
    const mode = d.deviceProperties?.developerModeStatus;
    const developerMode = mode === "enabled" ? true : mode === "disabled" ? false : null;
    out.push({
      device: {
        id: hw.udid,
        platform: "ios",
        kind: "real",
        name: d.deviceProperties?.name ?? hw.marketingName ?? hw.udid,
        osVersion: d.deviceProperties?.osVersionNumber ?? "",
        state: paired && connected && developerMode === true ? "booted" : "unknown",
        managed: false,
        serial: null,
        locale: null,
      },
      developerMode,
      paired,
      connected,
    });
  }
  return out;
}

const LockStateSchema = z.object({
  info: z.object({ outcome: z.string() }),
  result: z.object({ passcodeRequired: z.boolean() }),
});

/** devicectl device info lockState JSON → 지금 잠겨 있는지(암호를 넣어야 하는지) */
export function parseLockState(json: unknown): boolean {
  const parsed = LockStateSchema.parse(json);
  if (parsed.info.outcome !== "success") throw new Error(`devicectl 잠금 상태를 읽지 못했다: ${parsed.info.outcome}`);
  return parsed.result.passcodeRequired;
}

const AppsSchema = z.object({ info: z.object({ outcome: z.string() }), result: z.object({ apps: z.array(z.object({ bundleIdentifier: z.string().optional() })) }) });

/** devicectl device info apps JSON → 앱 수 */
export function appsCount(json: unknown): number {
  const parsed = AppsSchema.parse(json);
  if (parsed.info.outcome !== "success") throw new Error(`devicectl 앱 목록을 읽지 못했다: ${parsed.info.outcome}`);
  return parsed.result.apps.length;
}

/** DevToolsSecurity -status 출력 → Mac 의 개발 도구 보안 설정이 켜져 있는지. 모르는 출력이면 예외 */
export function parseDevToolsSecurity(output: string): boolean {
  if (/currently enabled/i.test(output)) return true;
  if (/currently disabled/i.test(output)) return false;
  throw new Error(`DevToolsSecurity 출력을 해석하지 못했다: ${output.trim().slice(0, 120)}`);
}

/** security find-identity -v -p codesigning 출력 → 유효한 서명 인증서의 SHA-1(대문자 16진수) */
export function parseValidIdentityHashes(output: string): Set<string> {
  const hashes = new Set<string>();
  for (const m of output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"/gm)) {
    if (m[1]) hashes.add(m[1]);
  }
  return hashes;
}

function subjectField(subject: string, key: string): string | null {
  for (const line of subject.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return null;
}

/**
 * security find-certificate -a -p -c "Apple Development" 의 PEM 묶음 → 서명할 수 있는 팀(팀 ID 순, 중복 없음).
 * 유효한 서명 인증서(개인 키가 있는) 목록에 있고 기한이 남은 인증서만 쓴다. 팀 ID 는 인증서의 OU, 이름은 O 다
 */
export function signingTeamsFromPems(pems: string, validHashes: ReadonlySet<string>, now: Date): IosSigningTeam[] {
  const teams = new Map<string, string>();
  for (const block of pems.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    const cert = new X509Certificate(block);
    const sha1 = cert.fingerprint.replaceAll(":", "").toUpperCase();
    if (!validHashes.has(sha1)) continue;
    if (new Date(cert.validTo).getTime() <= now.getTime()) continue;
    const cn = subjectField(cert.subject, "CN") ?? "";
    if (!cn.startsWith("Apple Development:") && !cn.startsWith("iPhone Developer:")) continue;
    const team = subjectField(cert.subject, "OU");
    if (!team || !/^[A-Z0-9]{10}$/.test(team)) continue;
    if (!teams.has(team)) teams.set(team, subjectField(cert.subject, "O") ?? team);
  }
  return [...teams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, name]) => ({ id, name }));
}

/** 러너 번들 ID. 무료 개인 팀도 쓸 수 있게 팀마다 다른 고유 ID 를 만든다 */
export function runnerBundleId(teamId: string): string {
  return `dev.avocado.agentdevice.${teamId.toLowerCase()}.runner`;
}
