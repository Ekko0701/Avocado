import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../setup/command";
import { DeviceError, DeviceService } from "./device-service";

const RUNTIMES = readFileSync(join(__dirname, "fixtures", "simctl-runtimes-2026-10-21.json"), "utf8");
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

let sdk: string;
beforeEach(() => {
  sdk = mkdtempSync(join(tmpdir(), "qa-sdk-"));
  for (const p of ["emulator/emulator", "platform-tools/adb"]) {
    mkdirSync(join(sdk, p, ".."), { recursive: true });
    writeFileSync(join(sdk, p), "");
    chmodSync(join(sdk, p), 0o755);
  }
});
afterEach(() => rmSync(sdk, { recursive: true, force: true }));

/** iOS 시뮬레이터 하나를 흉내 내는 실행기. 언어는 defaults write 후 재부팅해야 바뀐다. */
function fakeIos(opts: { initialLocale: string; applyLocale?: boolean; existingName?: string }) {
  const calls: string[] = [];
  let created = opts.existingName !== undefined;
  let simName = opts.existingName ?? "";
  let state = "Shutdown";
  let locale = opts.initialLocale;
  let pending: string | null = null;
  const run: CommandRunner = async (file, args) => {
    const cmd = [file, ...args].join(" ");
    calls.push(cmd);
    const sub = args.slice(1).join(" ");
    if (sub === "list runtimes -j") return ok(RUNTIMES);
    if (sub === "list devices -j") {
      const devices = created ? [{ udid: "UDID-1", name: simName, state, isAvailable: true }] : [];
      return ok(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": devices } }));
    }
    if (args[1] === "create") {
      created = true;
      simName = args[2] ?? "";
      return ok("UDID-1\n");
    }
    if (args[1] === "boot") {
      if (pending && opts.applyLocale !== false) locale = pending;
      pending = null;
      state = "Booted";
      return ok();
    }
    if (args[1] === "bootstatus") return ok();
    if (args[1] === "shutdown") {
      state = "Shutdown";
      return ok();
    }
    if (sub === "spawn UDID-1 defaults read -g AppleLocale") return ok(`${locale}\n`);
    if (sub.startsWith("spawn UDID-1 defaults write -g AppleLocale -string ")) {
      pending = args.at(-1) ?? null;
      return ok();
    }
    if (sub.startsWith("spawn UDID-1 defaults write")) return ok();
    return { code: 1, stdout: "", stderr: `not mocked: ${cmd}` };
  };
  return { run, calls };
}

function service(run: CommandRunner, extra: Partial<ConstructorParameters<typeof DeviceService>[0]> = {}) {
  return new DeviceService({
    run,
    spawnDetached: () => undefined,
    androidHome: sdk,
    locale: () => "ko_KR",
    logDir: join(sdk, "logs"),
    sleep: async () => undefined,
    timeoutMs: 1_000,
    pollMs: 1,
    ...extra,
  });
}

describe("prepareIos", () => {
  it("지원 런타임으로 기기를 만들고, 호스트 언어(en_US)를 설정 언어(ko_KR)로 바꾼 뒤 재부팅한다", async () => {
    const ios = fakeIos({ initialLocale: "en_US" });
    const device = await service(ios.run).prepareIos({});
    expect(device).toMatchObject({ id: "UDID-1", name: "Avocado iPhone 17", osVersion: "27.0", state: "booted", locale: "ko_KR" });
    expect(ios.calls).toContain(
      "/usr/bin/xcrun simctl create Avocado iPhone 17 com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    );
    expect(ios.calls).toContain("/usr/bin/xcrun simctl spawn UDID-1 defaults write -g AppleLanguages -array ko-KR");
    expect(ios.calls).toContain("/usr/bin/xcrun simctl shutdown UDID-1");
    expect(ios.calls).toContain(
      "/usr/bin/xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility ReduceMotionEnabled -bool true",
    );
  });

  it("이름을 바꾸기 전(QA Tool) 시뮬레이터가 있으면 새로 만들지 않고 그대로 쓴다(D14)", async () => {
    const f = fakeIos({ initialLocale: "ko_KR", existingName: "QA Tool iPhone 17" });
    const device = await service(f.run).prepareIos({});
    expect(device).toMatchObject({ id: "UDID-1", name: "QA Tool iPhone 17", state: "booted" });
    expect(f.calls.some((c) => c.includes("simctl create"))).toBe(false);
    expect((await service(f.run).list()).devices.map((d) => d.name)).toContain("QA Tool iPhone 17");
  });

  it("이미 설정 언어면 언어를 다시 쓰거나 재부팅하지 않는다", async () => {
    const ios = fakeIos({ initialLocale: "ko_KR" });
    await service(ios.run).prepareIos({});
    expect(ios.calls.some((c) => c.includes("AppleLocale -string"))).toBe(false);
    expect(ios.calls.some((c) => c.endsWith("shutdown UDID-1"))).toBe(false);
  });

  it("언어가 적용되지 않으면 조용히 넘어가지 않는다", async () => {
    const ios = fakeIos({ initialLocale: "en_US", applyLocale: false });
    await expect(service(ios.run).prepareIos({})).rejects.toThrow(/ko_KR 로 바뀌지 않았다/);
  });
});

/** 에뮬레이터 하나를 흉내 낸다. -change-locale 로 띄우면 잠시 뒤 언어가 바뀐다. */
function fakeAndroid(opts: { runningWithLocale?: string; applyLocale?: boolean; settingsUnavailableTimes?: number }) {
  const calls: string[] = [];
  const settings = new Map<string, string>();
  let unavailable = opts.settingsUnavailableTimes ?? 0;
  const spawned: string[][] = [];
  let running = opts.runningWithLocale !== undefined;
  let locale = opts.runningWithLocale ?? "";
  let localeProbes = 0;
  const adb = `${sdk}/platform-tools/adb`;
  const run: CommandRunner = async (file, args) => {
    const cmd = [file, ...args].join(" ");
    calls.push(cmd);
    if (file.endsWith("/emulator/emulator") && args[0] === "-list-avds") return ok("qa_pixel_7_api35\n");
    if (file === adb && args[0] === "devices") return ok(`List of devices attached\n${running ? "emulator-5554\tdevice\n" : ""}`);
    if (file === adb && args.join(" ") === "-s emulator-5554 emu avd name") return ok("qa_pixel_7_api35\nOK\n");
    if (file === adb && args.join(" ") === "-s emulator-5554 emu kill") {
      running = false;
      return ok();
    }
    const shell = args.slice(3).join(" ");
    if (shell === "getprop sys.boot_completed") return ok("1\n");
    if (shell === "getprop persist.sys.locale") {
      localeProbes += 1;
      return ok(`${localeProbes > 1 && opts.applyLocale !== false && spawned.length > 0 ? "ko-KR" : locale}\n`);
    }
    if (shell === "getprop ro.product.locale") return ok("en-US\n");
    if (shell.startsWith("settings put global")) {
      // 프레임워크 재시작 중에는 설정 서비스가 잠깐 없다
      if (unavailable > 0) {
        unavailable -= 1;
        return { code: 1, stdout: "", stderr: "cmd: Can't find service: settings" };
      }
      settings.set(args[6] ?? "", args[7] ?? "");
      return ok();
    }
    if (shell.startsWith("settings get global")) return ok(`${settings.get(args[6] ?? "") ?? "1.0"}\n`);
    if (shell === "getprop ro.build.version.release") return ok("15\n");
    return { code: 1, stdout: "", stderr: `not mocked: ${cmd}` };
  };
  const spawnDetached = (_file: string, args: string[]) => {
    spawned.push(args);
    running = true;
    locale = "";
  };
  return { run, calls, spawned, spawnDetached };
}

describe("prepareAndroid", () => {
  it("AVD 를 화면 없이 설정 언어로 띄우고 애니메이션 3종을 끈다", async () => {
    const a = fakeAndroid({});
    const device = await service(a.run, { spawnDetached: a.spawnDetached }).prepareAndroid({});
    expect(a.spawned[0]).toEqual([
      "-avd",
      "qa_pixel_7_api35",
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot-save",
      "-change-locale",
      "ko-KR",
    ]);
    for (const key of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
      expect(a.calls).toContain(`${sdk}/platform-tools/adb -s emulator-5554 shell settings put global ${key} 0`);
    }
    expect(device).toMatchObject({ id: "qa_pixel_7_api35", serial: "emulator-5554", locale: "ko-KR", osVersion: "15" });
  });

  it("프레임워크 재시작 중 설정 쓰기가 잠깐 실패해도 다시 시도해 끈다", async () => {
    const a = fakeAndroid({ settingsUnavailableTimes: 2 });
    await service(a.run, { spawnDetached: a.spawnDetached }).prepareAndroid({});
    const puts = a.calls.filter((c) => c.includes("settings put global transition_animation_scale 0"));
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(a.calls.filter((c) => c.includes("settings put global window_animation_scale 0")).length).toBe(3);
  });

  it("다른 언어(en-US)로 실행 중이면 끄고 설정 언어로 다시 띄운다", async () => {
    const a = fakeAndroid({ runningWithLocale: "en-US" });
    await service(a.run, { spawnDetached: a.spawnDetached }).prepareAndroid({});
    expect(a.calls).toContain(`${sdk}/platform-tools/adb -s emulator-5554 emu kill`);
    expect(a.spawned).toHaveLength(1);
  });

  it("언어가 끝내 적용되지 않으면 오류를 낸다", async () => {
    const a = fakeAndroid({ applyLocale: false });
    await expect(service(a.run, { spawnDetached: a.spawnDetached }).prepareAndroid({})).rejects.toBeInstanceOf(DeviceError);
  });

  it("Android SDK 가 없으면 바로 알린다", async () => {
    const a = fakeAndroid({});
    await expect(service(a.run, { androidHome: join(sdk, "none") }).prepareAndroid({})).rejects.toThrow(/Android SDK/);
  });
});
