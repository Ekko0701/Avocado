import type { Device } from "@qa/shared";
import { join } from "node:path";
import type { CommandRunner } from "../setup/command";

/** Maestro 2.11.0 의 드라이버 앱 (2026-10-21 실행 중 프로세스·설치 앱으로 확인) */
export const IOS_DRIVER_BUNDLE_ID = "dev.mobile.maestro-driver-iosUITests.xctrunner";
export const ANDROID_DRIVER_PACKAGES = ["dev.mobile.maestro", "dev.mobile.maestro.test"] as const;

/**
 * `ps -axo pid=,command=` 출력에서 이 기기에 붙은 이전 Maestro 프로세스를 찾는다.
 * - maestro CLI: `maestro.cli.AppKt --device <id>`
 * - iOS 테스트 러너: `xcodebuild test-without-building ... -destination id=<UDID>`
 * - iOS 드라이버 앱: `.../CoreSimulator/Devices/<UDID>/.../maestro-driver-iosUITests-Runner`
 * 다른 기기의 프로세스와 자기 자신은 건드리지 않는다.
 */
export function staleDriverPids(psOutput: string, deviceArg: string, udid: string | null, ownPid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === ownPid) continue;
    const cli = cmd.includes("maestro.cli.AppKt") && new RegExp(`--device[ =]${escape(deviceArg)}(\\s|$)`).test(cmd);
    const xcodebuild = udid !== null && /\bxcodebuild\b/.test(cmd) && cmd.includes("maestro-driver") && cmd.includes(`id=${udid}`);
    const runner = udid !== null && cmd.includes("maestro-driver-iosUITests-Runner") && cmd.includes(`/Devices/${udid}/`);
    if (cli || xcodebuild || runner) pids.push(pid);
  }
  return pids;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CleanupOptions {
  run: CommandRunner;
  device: Device;
  androidHome: string;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** 끝날 때까지 기다린 뒤 강제 종료 */
  graceMs?: number;
}

const alive = (kill: CleanupOptions["kill"], pid: number) => {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 실행 전에 이 기기의 잔여 드라이버를 정리한다(PLAN 7.2, ADR 0001·docs/poc/app.md 드라이버 시작 실패). 끝낸 프로세스 수를 돌려준다 */
export async function cleanupDrivers(options: CleanupOptions): Promise<number> {
  const { run, device, kill } = options;
  const deviceArg = device.platform === "android" ? (device.serial ?? device.id) : device.id;
  const ps = await run("/bin/ps", ["-axo", "pid=,command="]);
  const pids = ps.code === 0 ? staleDriverPids(ps.stdout, deviceArg, device.platform === "ios" ? device.id : null, process.pid) : [];
  for (const pid of pids) {
    try {
      kill(pid, "SIGTERM");
    } catch {
      // 이미 끝났다
    }
  }
  const deadline = Date.now() + (options.graceMs ?? 3000);
  while (pids.some((p) => alive(kill, p)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter((p) => alive(kill, p))) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // 이미 끝났다
    }
  }
  // 기기 안의 드라이버 앱도 끝낸다. 실행 중이 아니면 실패해도 된다.
  if (device.platform === "ios") {
    await run("/usr/bin/xcrun", ["simctl", "terminate", device.id, IOS_DRIVER_BUNDLE_ID]);
  } else if (device.serial) {
    const adb = join(options.androidHome, "platform-tools", "adb");
    for (const pkg of ANDROID_DRIVER_PACKAGES) await run(adb, ["-s", device.serial, "shell", "am", "force-stop", pkg]);
  }
  return pids.length;
}
