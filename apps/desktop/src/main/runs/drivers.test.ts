import type { Device } from "@qa/shared";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../setup/command";
import { cleanupDrivers, IOS_DRIVER_BUNDLE_ID, staleDriverPids } from "./drivers";

const UDID = "38D33774-E504-44EC-BE68-2E8FFB4E5D81";
const OTHER = "B971ACB8-F428-477F-BF02-E2976E979AC8";

// 2026-10-21 실제 실행 중 `ps -axo pid=,command=` 에서 본 모양(홈 경로만 줄임)
const PS = `
78119 /Users/tester/development/java/bin/java --enable-native-access=ALL-UNNAMED -classpath /Users/tester/.maestro/lib/* maestro.cli.AppKt --device ${UDID} test --test-output-dir out2 wait.yaml
78337 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test-without-building -xctestrun /var/folders/x/T/${UDID}123/maestro-driver-ios-config.xctestrun -destination id=${UDID} -derivedDataPath /var/folders/x/T/maestro_xctestrunner_xcodebuild_output1
78343 /Users/tester/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/A7/maestro-driver-iosUITests-Runner.app/maestro-driver-iosUITests-Runner
90001 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test-without-building -xctestrun /var/folders/x/T/${OTHER}1/maestro-driver-ios-config.xctestrun -destination id=${OTHER}
90002 java -classpath x maestro.cli.AppKt --device emulator-5554 test flow.yaml
90003 java -classpath x maestro.cli.AppKt --device emulator-55541 test flow.yaml
90004 /usr/bin/vim notes-${UDID}.txt
`;

describe("잔여 드라이버 찾기", () => {
  it("이 iOS 기기의 CLI·러너·드라이버 앱만 고른다", () => {
    expect(staleDriverPids(PS, UDID, UDID, 1)).toEqual([78119, 78337, 78343]);
    expect(staleDriverPids(PS, OTHER, OTHER, 1)).toEqual([90001]);
  });

  it("Android 는 serial 이 정확히 같은 CLI 만 고른다", () => {
    expect(staleDriverPids(PS, "emulator-5554", null, 1)).toEqual([90002]);
  });

  it("자기 프로세스는 고르지 않는다", () => {
    expect(staleDriverPids(PS, UDID, UDID, 78119)).toEqual([78337, 78343]);
  });
});

describe("정리", () => {
  const ios: Device = { id: UDID, platform: "ios", kind: "simulator", name: "QA Tool iPhone 17", osVersion: "27.0", state: "booted", managed: true, serial: null, locale: "ko_KR" };

  it("SIGTERM 을 보내고, 남으면 SIGKILL, 기기 안의 드라이버 앱도 끝낸다", async () => {
    const calls: string[] = [];
    const run: CommandRunner = (file, args) => {
      calls.push([file, ...args].join(" "));
      return Promise.resolve({ code: file === "/bin/ps" ? 0 : 1, stdout: file === "/bin/ps" ? PS : "", stderr: "" });
    };
    const signals: string[] = [];
    const alive = new Set([78119, 78337, 78343]);
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!alive.has(pid)) throw new Error("ESRCH");
        return;
      }
      signals.push(`${pid}:${signal}`);
      // 78343 은 SIGTERM 을 무시한다
      if (signal === "SIGKILL" || pid !== 78343) alive.delete(pid);
    };
    const n = await cleanupDrivers({ run, device: ios, androidHome: "/sdk", kill, graceMs: 200 });
    expect(n).toBe(3);
    expect(signals).toEqual(["78119:SIGTERM", "78337:SIGTERM", "78343:SIGTERM", "78343:SIGKILL"]);
    expect(calls).toContain(`/usr/bin/xcrun simctl terminate ${UDID} ${IOS_DRIVER_BUNDLE_ID}`);
  });

  it("Android 는 드라이버 패키지를 강제 종료한다", async () => {
    const calls: string[] = [];
    const run: CommandRunner = (file, args) => {
      calls.push([file, ...args].join(" "));
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const android: Device = { ...ios, id: "qa_pixel", platform: "android", kind: "emulator", serial: "emulator-5554" };
    await cleanupDrivers({ run, device: android, androidHome: "/sdk", kill: () => undefined });
    expect(calls.slice(1)).toEqual([
      "/sdk/platform-tools/adb -s emulator-5554 shell am force-stop dev.mobile.maestro",
      "/sdk/platform-tools/adb -s emulator-5554 shell am force-stop dev.mobile.maestro.test",
    ]);
  });
});
