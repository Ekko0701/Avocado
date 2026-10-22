import type { SetupCheck, ToolStatus } from "@qa/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./command";

export interface CheckDeps {
  run: CommandRunner;
  env: { HOME: string; ANDROID_HOME?: string | undefined };
  exists?: (path: string) => boolean;
  tools: ToolStatus[];
}

function check(partial: Omit<SetupCheck, "fix" | "tool"> & Partial<Pick<SetupCheck, "fix" | "tool">>): SetupCheck {
  return { fix: null, tool: null, ...partial };
}

/**
 * 앱 사용자에게 필요한 환경을 점검한다. scripts/bootstrap-mac.sh 의 점검 중 앱 실행에 필요한 것만 옮겼다.
 * Node·pnpm 같은 개발 도구는 점검하지 않는다. 명령은 모두 절대 경로로 부른다.
 */
export async function runEnvironmentChecks(deps: CheckDeps): Promise<SetupCheck[]> {
  const { run } = deps;
  const exists = deps.exists ?? existsSync;
  const checks: SetupCheck[] = [];

  const [osVersion, arch] = await Promise.all([
    run("/usr/bin/sw_vers", ["-productVersion"]),
    run("/usr/bin/uname", ["-m"]),
  ]);
  const isArm = arch.stdout.trim() === "arm64";
  checks.push(
    check({
      id: "macos",
      label: "macOS · Apple Silicon",
      status: isArm ? "ok" : "fail",
      required: true,
      detail: `macOS ${osVersion.stdout.trim() || "?"} (${arch.stdout.trim() || "?"})`,
      fix: isArm ? null : "지금은 Apple Silicon Mac만 지원한다 (D13)",
    }),
  );

  const xcodePath = await run("/usr/bin/xcode-select", ["-p"]);
  const xcodeSelected = xcodePath.code === 0 && xcodePath.stdout.includes(".app/Contents/Developer");
  const xcodeVersion = xcodeSelected ? await run("/usr/bin/xcodebuild", ["-version"]) : null;
  checks.push(
    check({
      id: "xcode",
      label: "Xcode",
      status: xcodeSelected ? "ok" : "fail",
      required: true,
      detail: xcodeSelected
        ? `${xcodeVersion?.stdout.split("\n")[0]?.trim() ?? "Xcode"} (${xcodePath.stdout.trim()})`
        : `Xcode.app 이 선택되지 않음: ${xcodePath.stdout.trim() || xcodePath.stderr.trim() || "없음"}`,
      fix: xcodeSelected ? null : "App Store 에서 Xcode 를 설치하고 터미널에서 sudo xcode-select -s /Applications/Xcode.app 실행",
    }),
  );

  if (xcodeSelected) {
    const firstLaunch = await run("/usr/bin/xcodebuild", ["-checkFirstLaunchStatus"]);
    checks.push(
      check({
        id: "xcode-first-launch",
        label: "Xcode 첫 실행 구성",
        status: firstLaunch.code === 0 ? "ok" : "fail",
        required: true,
        detail: firstLaunch.code === 0 ? "완료" : "필요한 구성 요소가 설치되지 않음",
        fix: firstLaunch.code === 0 ? null : "터미널에서 xcodebuild -runFirstLaunch 실행 (라이선스 동의는 직접)",
      }),
    );

    const runtimes = await run("/usr/bin/xcrun", ["simctl", "list", "runtimes", "-j"], { timeoutMs: 60_000 });
    let names: string[];
    try {
      const parsed = JSON.parse(runtimes.stdout) as { runtimes?: { name?: string; isAvailable?: boolean }[] };
      names = (parsed.runtimes ?? [])
        .filter((r) => r.isAvailable && r.name?.startsWith("iOS"))
        .map((r) => r.name ?? "");
    } catch {
      names = [];
    }
    checks.push(
      check({
        id: "ios-runtime",
        label: "iOS 시뮬레이터 런타임",
        status: names.length > 0 ? "ok" : "fail",
        required: true,
        detail: names.length > 0 ? names.join(", ") : "사용 가능한 iOS 런타임 없음",
        fix: names.length > 0 ? null : "Xcode > Settings > Components 에서 iOS 런타임 설치",
      }),
    );
  }

  const git = await run("/usr/bin/git", ["--version"]);
  checks.push(
    check({
      id: "git",
      label: "git",
      status: git.code === 0 ? "ok" : "fail",
      required: true,
      detail: git.code === 0 ? git.stdout.trim() : "git 을 실행할 수 없음",
      fix: git.code === 0 ? null : "Xcode 명령줄 도구 설치: xcode-select --install",
    }),
  );

  const sdk = deps.env.ANDROID_HOME || join(deps.env.HOME, "Library", "Android", "sdk");
  const adb = exists(join(sdk, "platform-tools", "adb"));
  const emulator = exists(join(sdk, "emulator", "emulator"));
  checks.push(
    check({
      id: "android-sdk",
      label: "Android SDK (선택)",
      status: adb && emulator ? "ok" : "warn",
      required: false,
      detail: adb && emulator ? sdk : `adb ${adb ? "있음" : "없음"}, emulator ${emulator ? "있음" : "없음"} (${sdk})`,
      fix: adb && emulator ? null : "Android 앱을 테스트할 때만 필요. Android Studio 로 SDK 설치",
    }),
  );

  for (const tool of deps.tools) {
    const label = tool.id === "jre" ? `Java 런타임 (Temurin ${tool.version})` : `Maestro ${tool.version}`;
    checks.push(
      check({
        id: `tool-${tool.id}`,
        label,
        status: tool.installed ? "ok" : "fail",
        required: true,
        detail: tool.installed ? "앱이 관리하는 도구로 설치됨" : `설치 필요 (약 ${Math.round(tool.downloadBytes / 1_048_576)}MB)`,
        tool: tool.installed ? null : tool.id,
      }),
    );
  }

  return checks;
}
