import type { Device, DeviceList, IosDeviceOptions } from "@qa/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../setup/command";
import { androidLocale, chooseAvd, parseAvdList, parseEmulatorSerials } from "./android";
import {
  appleLocaleValues,
  findNewestDevice,
  iosDeviceChoices,
  iosVersionFromRuntimeId,
  pickRuntime,
  simState,
  type SimDevice,
  type SimRuntime,
} from "./ios";

export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceError";
  }
}

export interface DeviceServiceOptions {
  run: CommandRunner;
  /** 에뮬레이터처럼 오래 도는 프로세스를 분리 실행한다. 로그는 logFile 로. */
  spawnDetached: (file: string, args: string[], logFile: string) => void;
  androidHome: string;
  /** 설정의 QA 기기 언어 (예: ko_KR) */
  locale: () => string;
  logDir: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** iOS 부팅 대기 상한. 기본 10분 */
  iosBootTimeoutMs?: number;
  pollMs?: number;
  /** 기기를 지우면 안 되는 이유(실행·플로우 만들기 진행 중). 없으면 null */
  busy?: () => string | null;
}

export const DEFAULT_IOS_DEVICE_TYPE = "iPhone 17";
export const MANAGED_PREFIX = "Avocado ";
/** 앱 이름을 바꾸기 전(D14, 2026-10-22)에 만든 시뮬레이터도 앱 기기로 계속 쓴다(설치한 앱·설정을 잃지 않게) */
export const LEGACY_PREFIXES = ["QA Tool "] as const;
const isManagedName = (name: string) => [MANAGED_PREFIX, ...LEGACY_PREFIXES].some((p) => name.startsWith(p));
/** 새로 만드는 앱 시뮬레이터 이름: 같은 기종을 여러 iOS 버전으로 둘 수 있게 버전을 붙인다 */
export const managedSimName = (deviceType: string, iosVersion: string) => `${MANAGED_PREFIX}${deviceType} (iOS ${iosVersion})`;
/** 이 기종의 앱 시뮬레이터인가: 새 이름(버전 포함)이거나 예전 이름(버전 없음, "Avocado ", "QA Tool ") */
const isManagedSimFor = (name: string, deviceType: string, runtimeId: string) =>
  name === managedSimName(deviceType, iosVersionFromRuntimeId(runtimeId)) || [MANAGED_PREFIX, ...LEGACY_PREFIXES].some((p) => name === `${p}${deviceType}`);
const ANIMATION_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"] as const;

/**
 * QA 기기 관리 (PLAN 3.2, T-104).
 * - iOS: 앱 전용 시뮬레이터("Avocado <기종> (iOS <버전>)". 예전 "Avocado <기종>", "QA Tool <기종>"도 그대로 쓴다)를 고른 기종·iOS 런타임으로 만들고,
 *   언어와 동작 줄이기를 맞춘다. 사용자가 직접 만든 시뮬레이터는 목록에 넣지도, 바꾸지도, 지우지도 않는다.
 * - Android: 기존 AVD 를 화면 없이 설정 언어로 부팅하고 애니메이션을 끈다.
 * 언어가 실제로 적용되지 않으면 조용히 넘어가지 않고 오류를 낸다(ADR 0001 발견 2).
 */
export class DeviceService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly iosBootTimeoutMs: number;

  constructor(private readonly options: DeviceServiceOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.pollMs = options.pollMs ?? 2_000;
    this.iosBootTimeoutMs = options.iosBootTimeoutMs ?? 600_000;
  }

  private get emulator() {
    return join(this.options.androidHome, "emulator", "emulator");
  }
  private get adb() {
    return join(this.options.androidHome, "platform-tools", "adb");
  }

  androidAvailable(): boolean {
    return existsSync(this.emulator) && existsSync(this.adb);
  }

  private async simctl(args: string[], timeoutMs = 120_000) {
    const r = await this.options.run("/usr/bin/xcrun", ["simctl", ...args], { timeoutMs });
    if (r.code !== 0) throw new DeviceError(`simctl ${args[0]} 실패: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout;
  }

  private async simDevices(): Promise<Record<string, SimDevice[]>> {
    return (JSON.parse(await this.simctl(["list", "devices", "-j"])) as { devices: Record<string, SimDevice[]> }).devices;
  }

  private async iosLocale(udid: string): Promise<string | null> {
    const r = await this.options.run("/usr/bin/xcrun", ["simctl", "spawn", udid, "defaults", "read", "-g", "AppleLocale"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async bootIos(udid: string): Promise<void> {
    const r = await this.options.run("/usr/bin/xcrun", ["simctl", "boot", udid], { timeoutMs: 120_000 });
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) {
      throw new DeviceError(`시뮬레이터 부팅 실패: ${r.stderr.trim().slice(0, 300)}`);
    }
    // 새 기기의 첫 부팅은 데이터 준비로 오래 걸린다. 부하가 높은 Mac 에서 5분을 넘긴 사례가 있어 넉넉히 기다린다.
    await this.simctl(["bootstatus", udid, "-b"], Math.max(this.timeoutMs, this.iosBootTimeoutMs));
  }

  async list(): Promise<DeviceList> {
    const devices: Device[] = [];
    const byRuntime = await this.simDevices();
    for (const [runtimeId, sims] of Object.entries(byRuntime)) {
      for (const sim of sims) {
        if (!isManagedName(sim.name) || sim.isAvailable === false) continue;
        devices.push({
          id: sim.udid,
          platform: "ios",
          kind: "simulator",
          name: sim.name,
          osVersion: iosVersionFromRuntimeId(runtimeId),
          state: simState(sim.state),
          managed: true,
          serial: null,
          locale: null,
        });
      }
    }
    const androidAvailable = this.androidAvailable();
    if (androidAvailable) {
      const avds = parseAvdList((await this.options.run(this.emulator, ["-list-avds"])).stdout);
      const running = await this.runningAvds();
      for (const avd of avds) {
        const serial = running.get(avd) ?? null;
        devices.push({
          id: avd,
          platform: "android",
          kind: "emulator",
          name: avd,
          osVersion: "",
          state: serial ? "booted" : "shutdown",
          managed: avd.startsWith("qa_"),
          serial,
          locale: null,
        });
      }
    }
    return { devices, androidAvailable };
  }

  private async simRuntimes(): Promise<SimRuntime[]> {
    return (JSON.parse(await this.simctl(["list", "runtimes", "-j"])) as { runtimes: SimRuntime[] }).runtimes;
  }

  /** 기기 화면에서 고를 수 있는 iOS 런타임과 기종 */
  async iosOptions(): Promise<IosDeviceOptions> {
    return { runtimes: iosDeviceChoices(await this.simRuntimes()), defaultDeviceType: DEFAULT_IOS_DEVICE_TYPE };
  }

  /**
   * 기종(없으면 기본)과 iOS 런타임으로 앱 시뮬레이터를 준비한다.
   * 런타임을 고르면 그 런타임의 앱 기기를 쓰거나 만든다. 고르지 않으면 이 기종의 앱 기기 중 가장 새 iOS 것을 다시 쓰고,
   * 없으면 기종을 지원하는 최신 런타임으로 만든다(설정 마법사·예전 기기 그대로)
   */
  async prepareIos(input: { deviceType?: string; runtime?: string }): Promise<Device> {
    const deviceType = input.deviceType ?? DEFAULT_IOS_DEVICE_TYPE;
    // 고른 조합이 이 Mac 에 없으면 기기를 찾기 전에 알린다
    const { runtime, deviceTypeId } = pickRuntime(await this.simRuntimes(), deviceType, input.runtime);

    const sims = await this.simDevices();
    let found = findNewestDevice(sims, (d, runtimeId) => isManagedSimFor(d.name, deviceType, runtimeId) && (!input.runtime || runtimeId === input.runtime));
    if (!found) {
      const name = managedSimName(deviceType, iosVersionFromRuntimeId(runtime.identifier));
      const udid = (await this.simctl(["create", name, deviceTypeId, runtime.identifier])).trim();
      found = { device: { udid, name, state: "Shutdown" }, runtimeId: runtime.identifier };
    }
    const { udid } = found.device;
    await this.bootIos(udid);

    const { appleLocale, appleLanguage } = appleLocaleValues(this.options.locale());
    if ((await this.iosLocale(udid)) !== appleLocale) {
      await this.simctl(["spawn", udid, "defaults", "write", "-g", "AppleLocale", "-string", appleLocale]);
      await this.simctl(["spawn", udid, "defaults", "write", "-g", "AppleLanguages", "-array", appleLanguage]);
      // 전역 언어는 재부팅해야 앱에 적용된다.
      await this.simctl(["shutdown", udid]);
      await this.bootIos(udid);
    }
    await this.simctl(["spawn", udid, "defaults", "write", "com.apple.Accessibility", "ReduceMotionEnabled", "-bool", "true"]);

    const locale = await this.iosLocale(udid);
    if (locale !== appleLocale) throw new DeviceError(`시뮬레이터 언어가 ${appleLocale} 로 바뀌지 않았다 (현재 ${locale ?? "알 수 없음"})`);
    return {
      id: udid,
      platform: "ios",
      kind: "simulator",
      // 예전 이름으로 만든 시뮬레이터를 다시 쓰면 그 이름 그대로
      name: found.device.name,
      osVersion: iosVersionFromRuntimeId(found.runtimeId),
      state: "booted",
      managed: true,
      serial: null,
      locale,
    };
  }

  /** 실행 중인 에뮬레이터: AVD 이름 → serial */
  private async runningAvds(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const serials = parseEmulatorSerials((await this.options.run(this.adb, ["devices"])).stdout);
    for (const serial of serials) {
      const name = (await this.options.run(this.adb, ["-s", serial, "emu", "avd", "name"])).stdout.split("\n")[0]?.trim();
      if (name) result.set(name, serial);
    }
    return result;
  }

  private async adbShell(serial: string, args: string[]) {
    return this.options.run(this.adb, ["-s", serial, "shell", ...args], { timeoutMs: 30_000 });
  }

  private async androidLocaleOf(serial: string): Promise<string | null> {
    const persisted = (await this.adbShell(serial, ["getprop", "persist.sys.locale"])).stdout.trim();
    if (persisted) return persisted;
    const product = (await this.adbShell(serial, ["getprop", "ro.product.locale"])).stdout.trim();
    return product || null;
  }

  private async waitFor<T>(what: string, probe: () => Promise<T | null>): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new DeviceError(`${what}: ${Math.round(this.timeoutMs / 1000)}초 안에 끝나지 않았다`);
      await this.sleep(this.pollMs);
    }
  }

  async prepareAndroid(input: { avd?: string }): Promise<Device> {
    if (!this.androidAvailable()) throw new DeviceError("Android SDK(emulator, adb)를 찾지 못했다");
    const avds = parseAvdList((await this.options.run(this.emulator, ["-list-avds"])).stdout);
    const avd = chooseAvd(avds, input.avd);
    if (!avd) throw new DeviceError(input.avd ? `AVD '${input.avd}' 이 없다` : "AVD 가 없다. scripts/bootstrap-mac.sh --install 또는 Android Studio 로 만든다");
    const target = androidLocale(this.options.locale());

    let serial = (await this.runningAvds()).get(avd) ?? null;
    if (serial && (await this.androidLocaleOf(serial)) !== target) {
      // 실행 중인 에뮬레이터의 언어는 바꿀 수 없어 끄고 다시 띄운다.
      await this.options.run(this.adb, ["-s", serial, "emu", "kill"]);
      const old = serial;
      await this.waitFor("에뮬레이터 종료", async () => ((await this.runningAvds()).get(avd) === old ? null : true));
      serial = null;
    }
    if (!serial) {
      this.options.spawnDetached(
        this.emulator,
        ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-change-locale", target],
        join(this.options.logDir, `emulator-${avd}.log`),
      );
      serial = await this.waitFor("에뮬레이터 시작", async () => (await this.runningAvds()).get(avd) ?? null);
    }
    const s = serial;
    await this.waitFor("에뮬레이터 부팅", async () =>
      (await this.adbShell(s, ["getprop", "sys.boot_completed"])).stdout.trim() === "1" ? true : null,
    );
    // -change-locale 은 부팅 뒤 프레임워크를 다시 시작한다. 언어가 바뀔 때까지 기다린다.
    const locale = await this.waitFor(`에뮬레이터 언어 ${target} 적용`, async () =>
      (await this.androidLocaleOf(s)) === target ? target : null,
    );
    await this.waitFor("에뮬레이터 재시작 후 부팅", async () =>
      (await this.adbShell(s, ["getprop", "sys.boot_completed"])).stdout.trim() === "1" ? true : null,
    );
    // -change-locale 은 프레임워크를 다시 시작하는데, sys.boot_completed 는 그동안에도 1 로 남는다.
    // 그 사이 설정 서비스가 잠깐 없어 쓰기가 실패할 수 있으므로, 쓰고 다시 읽어 0 이 될 때까지 반복한다.
    for (const key of ANIMATION_KEYS) {
      await this.waitFor(`애니메이션 끄기(${key})`, async () => {
        const put = await this.adbShell(s, ["settings", "put", "global", key, "0"]);
        if (put.code !== 0) return null;
        const value = (await this.adbShell(s, ["settings", "get", "global", key])).stdout.trim();
        return value === "0" || value === "0.0" ? true : null;
      });
    }
    const release = (await this.adbShell(s, ["getprop", "ro.build.version.release"])).stdout.trim();
    return {
      id: avd,
      platform: "android",
      kind: "emulator",
      name: avd,
      osVersion: release,
      state: "booted",
      managed: avd.startsWith("qa_"),
      serial: s,
      locale,
    };
  }

  /** 앱이 만든 iOS 시뮬레이터만 지운다. 켜져 있으면 끄고 지운다. 실행·플로우 만들기 중에는 거부한다 */
  async deleteIos(input: { id: string }): Promise<DeviceList> {
    const busy = this.options.busy?.();
    if (busy) throw new DeviceError(`${busy}. 끝난 뒤 지운다`);
    const sim = Object.values(await this.simDevices())
      .flat()
      .find((d) => d.udid === input.id);
    if (!sim) throw new DeviceError(`시뮬레이터를 찾지 못했다: ${input.id}`);
    if (!isManagedName(sim.name)) throw new DeviceError(`Avocado 가 만든 시뮬레이터만 지운다: ${sim.name}`);
    if (simState(sim.state) !== "shutdown") {
      const r = await this.options.run("/usr/bin/xcrun", ["simctl", "shutdown", input.id]);
      if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw new DeviceError(`시뮬레이터 종료 실패: ${r.stderr.trim().slice(0, 300)}`);
    }
    await this.simctl(["delete", input.id]);
    return this.list();
  }

  async shutdown(ref: { platform: "ios" | "android"; id: string }): Promise<Device> {
    if (ref.platform === "ios") {
      const r = await this.options.run("/usr/bin/xcrun", ["simctl", "shutdown", ref.id]);
      if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw new DeviceError(`시뮬레이터 종료 실패: ${r.stderr.trim()}`);
    } else {
      const serial = (await this.runningAvds()).get(ref.id);
      if (serial) {
        await this.options.run(this.adb, ["-s", serial, "emu", "kill"]);
        await this.waitFor("에뮬레이터 종료", async () => ((await this.runningAvds()).has(ref.id) ? null : true));
      }
    }
    const device = (await this.list()).devices.find((d) => d.id === ref.id && d.platform === ref.platform);
    if (!device) throw new DeviceError(`기기를 찾지 못했다: ${ref.id}`);
    return device;
  }
}
