import type { ToolStatus } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { runEnvironmentChecks } from "./checks";
import type { CommandResult, CommandRunner } from "./command";

const OK = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (code = 1, stderr = "error"): CommandResult => ({ code, stdout: "", stderr });

const healthy: Record<string, CommandResult> = {
  "/usr/bin/sw_vers -productVersion": OK("27.0.1\n"),
  "/usr/bin/uname -m": OK("arm64\n"),
  "/usr/bin/xcode-select -p": OK("/Applications/Xcode.app/Contents/Developer\n"),
  "/usr/bin/xcodebuild -version": OK("Xcode 27.1\nBuild version 27B123\n"),
  "/usr/bin/xcodebuild -checkFirstLaunchStatus": OK(),
  "/usr/bin/xcrun simctl list runtimes -j": OK(
    JSON.stringify({ runtimes: [{ name: "iOS 27.0", isAvailable: true }, { name: "watchOS 12.0", isAvailable: true }] }),
  ),
  "/usr/bin/git --version": OK("git version 2.50.1\n"),
};

function runner(overrides: Record<string, CommandResult> = {}): CommandRunner {
  const table = { ...healthy, ...overrides };
  return async (file, args) => table[[file, ...args].join(" ")] ?? FAIL(127, "not mocked");
}

const installed: ToolStatus[] = [
  { id: "jre", version: "21", installed: true, path: "/x/jre", downloadBytes: 1 },
  { id: "maestro", version: "2.11.0", installed: true, path: "/x/maestro", downloadBytes: 1 },
];
const env = { HOME: "/Users/qa" };
const sdkPresent = () => true;

async function statusById(run: CommandRunner, tools = installed, exists = sdkPresent) {
  const checks = await runEnvironmentChecks({ run, env, tools, exists });
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

describe("runEnvironmentChecks", () => {
  it("정상 환경이면 모든 항목이 ok 다", async () => {
    const checks = await statusById(runner());
    for (const id of ["macos", "xcode", "xcode-first-launch", "ios-runtime", "git", "android-sdk", "tool-jre", "tool-maestro"]) {
      expect(checks[id]?.status, id).toBe("ok");
    }
    expect(checks["ios-runtime"]?.detail).toBe("iOS 27.0");
  });

  it("Xcode 가 선택되지 않았으면 실패하고 고칠 방법을 알려 준다", async () => {
    const checks = await statusById(runner({ "/usr/bin/xcode-select -p": OK("/Library/Developer/CommandLineTools\n") }));
    expect(checks["xcode"]).toMatchObject({ status: "fail", required: true });
    expect(checks["xcode"]?.fix).toContain("xcode-select -s");
    expect(checks["ios-runtime"]).toBeUndefined();
  });

  it("iOS 런타임이 없거나 첫 실행 구성이 안 됐으면 실패한다", async () => {
    const checks = await statusById(
      runner({
        "/usr/bin/xcrun simctl list runtimes -j": OK(JSON.stringify({ runtimes: [] })),
        "/usr/bin/xcodebuild -checkFirstLaunchStatus": FAIL(69),
      }),
    );
    expect(checks["ios-runtime"]?.status).toBe("fail");
    expect(checks["xcode-first-launch"]?.status).toBe("fail");
  });

  it("Intel Mac 은 지원하지 않는다", async () => {
    const checks = await statusById(runner({ "/usr/bin/uname -m": OK("x86_64\n") }));
    expect(checks["macos"]?.status).toBe("fail");
  });

  it("Android SDK 가 없으면 경고일 뿐 필수가 아니다", async () => {
    const checks = await statusById(runner(), installed, () => false);
    expect(checks["android-sdk"]).toMatchObject({ status: "warn", required: false });
  });

  it("설치되지 않은 도구는 실패이며 앱이 설치할 도구로 표시한다", async () => {
    const tools: ToolStatus[] = installed.map((t) => ({ ...t, installed: false, path: null, downloadBytes: 300 * 1_048_576 }));
    const checks = await statusById(runner(), tools);
    expect(checks["tool-maestro"]).toMatchObject({ status: "fail", required: true, tool: "maestro" });
    expect(checks["tool-maestro"]?.detail).toContain("300MB");
  });
});
