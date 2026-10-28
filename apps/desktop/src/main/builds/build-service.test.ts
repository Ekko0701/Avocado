import type { Device } from "@qa/shared";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../db/database";
import { runCommand, type CommandRunner } from "../setup/command";
import { BuildError, BuildService } from "./build-service";
import { BuildFormatError } from "./metadata";
import { makeFakeApp, makeScript } from "../../../test-support/fake-builds";

let dir: string;
let db: AppDatabase;
let sdk: string;

const IOS: Device = { id: "UDID-1", platform: "ios", kind: "simulator", name: "QA Tool iPhone 17", osVersion: "27.0", state: "booted", managed: true, serial: null, locale: "ko_KR" };
const ANDROID: Device = { id: "qa_pixel", platform: "android", kind: "emulator", name: "qa_pixel", osVersion: "16", state: "booted", managed: true, serial: "emulator-5554", locale: "ko-KR" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-builds-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  sdk = join(dir, "sdk");
  mkdirSync(join(sdk, "build-tools", "36.0.0"), { recursive: true });
  writeFileSync(join(sdk, "build-tools", "36.0.0", "aapt2"), "");
  chmodSync(join(sdk, "build-tools", "36.0.0", "aapt2"), 0o755);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function service(opts: { run?: CommandRunner; devices?: Device[]; scriptTimeoutMs?: number } = {}) {
  let n = 0;
  return new BuildService({
    db,
    run: opts.run ?? runCommand,
    devices: { list: () => Promise.resolve({ devices: opts.devices ?? [IOS, ANDROID], androidAvailable: true }) },
    buildsDir: join(dir, "builds"),
    logDir: join(dir, "logs"),
    androidHome: sdk,
    home: dir,
    scriptTimeoutMs: opts.scriptTimeoutMs,
    now: () => new Date("2026-10-21T09:00:00.000Z"),
    newId: () => `build-${++n}`,
  });
}

/** aapt2 만 흉내 내고 나머지는 실제 명령을 쓰는 실행기 */
function withFakeAapt(badging: string): CommandRunner {
  return (file, args, options) =>
    file.endsWith("/aapt2") ? Promise.resolve({ code: 0, stdout: badging, stderr: "" }) : runCommand(file, args, options);
}

describe("파일 등록", () => {
  it(".app 을 앱 데이터 폴더로 복사하고 DB 에 기록한다", async () => {
    const src = makeFakeApp(join(dir, "src"), { name: "Sample", bundleId: "com.example.sample.dev", version: "1.2.3", build: "1" });
    const build = await service().registerPath("sample", src);
    expect(build).toMatchObject({ id: "build-1", app: "sample", target: "ios", appId: "com.example.sample.dev", version: "1.2.3", buildNumber: "1", source: "file", commit: null });
    expect(build.path).toBe(join(dir, "builds", "build-1", "Sample.app"));
    expect(readFileSync(join(build.path, "Fake"), "utf8")).toBe("binary");
    // 원본을 지워도 등록한 빌드는 남는다
    rmSync(src, { recursive: true });
    expect(service().list()).toEqual([build]);
  });

  it(".apk 는 aapt2 로 패키지 정보를 읽는다", async () => {
    const apk = join(dir, "app-debug.apk");
    writeFileSync(apk, "PK");
    const build = await service({ run: withFakeAapt("package: name='com.example.app' versionCode='7' versionName='2.0.0'\n") }).registerPath("example", apk);
    expect(build).toMatchObject({ target: "android", appId: "com.example.app", version: "2.0.0", buildNumber: "7" });
    expect(existsSync(build.path)).toBe(true);
  });

  it("경로 끝의 / 는 무시한다", async () => {
    const src = makeFakeApp(join(dir, "src"));
    await expect(service().registerPath("sample", `${src}/`)).resolves.toMatchObject({ target: "ios", appId: "net.example.fake" });
  });

  it("상대 경로, 없는 파일, 다른 형식은 거부한다", async () => {
    const s = service();
    await expect(s.registerPath("sample", "Sample.app")).rejects.toBeInstanceOf(BuildError);
    await expect(s.registerPath("sample", join(dir, "none.app"))).rejects.toBeInstanceOf(BuildError);
    writeFileSync(join(dir, "app.ipa"), "x");
    await expect(s.registerPath("sample", join(dir, "app.ipa"))).rejects.toBeInstanceOf(BuildFormatError);
  });

  it("메타데이터를 읽지 못하면 복사본을 지우고 기록하지 않는다", async () => {
    const src = makeFakeApp(join(dir, "src"), { platform: "iPhoneOS" });
    await expect(service().registerPath("sample", src)).rejects.toThrow(/시뮬레이터용 빌드가 아니다/);
    expect(readdirSync(join(dir, "builds"))).toEqual([]);
    expect(service().list()).toEqual([]);
  });
});

describe("빌드 스크립트", () => {
  it("스크립트가 QA_BUILD_INFO 에 적은 결과물을 스크립트 출처로 등록하고 출력은 로그로 남긴다", async () => {
    const app = makeFakeApp(join(dir, "out"), { name: "Sample" });
    const script = makeScript(join(dir), `echo "building $QA_APP"\nprintf 'ARTIFACT=%s\\nCOMMIT=abc1234\\n' "${app}" > "$QA_BUILD_INFO"`);
    const build = await service().runScript("sample", script);
    expect(build).toMatchObject({ app: "sample", source: "script", commit: "abc1234", appId: "net.example.fake" });
    const logs = readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".log"));
    expect(readFileSync(join(dir, "logs", logs[0] ?? ""), "utf8")).toContain("building sample");
  });

  it("COMMIT 이 git 해시 형식이 아니면 기록하지 않는다", async () => {
    const app = makeFakeApp(join(dir, "out"));
    const script = makeScript(dir, `printf 'ARTIFACT=%s\\nCOMMIT=not-a-hash!\\n' "${app}" > "$QA_BUILD_INFO"`);
    await expect(service().runScript("sample", script)).resolves.toMatchObject({ commit: null });
  });

  it("앱의 환경 변수를 통째로 넘기지 않는다", async () => {
    process.env["QA_TEST_SENTINEL_SECRET"] = "must-not-pass";
    try {
      const app = makeFakeApp(join(dir, "out"));
      const script = makeScript(dir, `env\nprintf 'ARTIFACT=%s\\n' "${app}" > "$QA_BUILD_INFO"`);
      await service().runScript("sample", script);
      const log = readdirSync(join(dir, "logs")).find((f) => f.endsWith(".log")) ?? "";
      const text = readFileSync(join(dir, "logs", log), "utf8");
      expect(text).not.toContain("must-not-pass");
      expect(text).toContain(`HOME=${dir}`);
      expect(text).toMatch(/PATH=.*\/opt\/homebrew\/bin/);
    } finally {
      delete process.env["QA_TEST_SENTINEL_SECRET"];
    }
  });

  it("실패, 결과물 미기록, 실행 권한 없음은 오류다", async () => {
    const s = service();
    await expect(s.runScript("sample", makeScript(dir, "echo boom >&2\nexit 3"))).rejects.toThrow(/코드 3\): boom/);
    await expect(s.runScript("sample", makeScript(dir, "true"))).rejects.toThrow(/ARTIFACT/);
    const plain = join(dir, "plain.sh");
    writeFileSync(plain, "#!/bin/sh\n");
    await expect(s.runScript("sample", plain)).rejects.toThrow(/실행 권한/);
  });

  it("빌드 스크립트는 한 번에 하나만 실행한다", async () => {
    const app = makeFakeApp(join(dir, "out"));
    const s = service();
    const first = s.runScript("sample", makeScript(dir, `sleep 0.5\nprintf 'ARTIFACT=%s\\n' "${app}" > "$QA_BUILD_INFO"`));
    await expect(s.runScript("sample", makeScript(join(dir, "out"), "true"))).rejects.toThrow(/이미 빌드가 진행 중이다/);
    await expect(first).resolves.toMatchObject({ source: "script" });
  });

  it("제한 시간을 넘기면 하위 프로세스까지 끝내고 오류를 낸다", async () => {
    const started = Date.now();
    const script = makeScript(dir, "sleep 30 &\nwait");
    await expect(service({ scriptTimeoutMs: 300 }).runScript("sample", script)).rejects.toThrow(/시간 초과/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("설치", () => {
  function recorder(results: Record<string, { code: number; stdout?: string }> = {}) {
    const calls: string[] = [];
    const run: CommandRunner = (file, args, options) => {
      const cmd = [file.split("/").pop(), ...args].join(" ");
      if (file === "/usr/bin/ditto" || file === "/usr/bin/plutil") return runCommand(file, args, options);
      calls.push(cmd);
      const hit = Object.entries(results).find(([k]) => cmd.startsWith(k))?.[1];
      return Promise.resolve({ code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: "" });
    };
    return { calls, run };
  }

  it("iOS: simctl install 후 앱 컨테이너로 설치를 확인한다", async () => {
    const { calls, run } = recorder();
    const s = service({ run });
    const build = await s.registerPath("sample", makeFakeApp(join(dir, "src"), { bundleId: "com.example.sample.dev" }));
    await expect(s.install(build.id, "UDID-1")).resolves.toEqual({ buildId: build.id, deviceId: "UDID-1", appId: "com.example.sample.dev", installed: true });
    expect(calls).toEqual([`xcrun simctl install UDID-1 ${build.path}`, "xcrun simctl get_app_container UDID-1 com.example.sample.dev app"]);
  });

  it("Android: adb install -r 후 pm path 로 설치를 확인한다", async () => {
    const apk = join(dir, "app.apk");
    writeFileSync(apk, "PK");
    const { calls, run } = recorder({
      aapt2: { code: 0, stdout: "package: name='com.example.app' versionCode='7' versionName='2.0.0'\n" },
      "adb -s emulator-5554 install": { code: 0, stdout: "Success\n" },
      "adb -s emulator-5554 shell pm path": { code: 0, stdout: "package:/data/app/base.apk\n" },
    });
    const s = service({ run });
    const build = await s.registerPath("example", apk);
    await expect(s.install(build.id, "qa_pixel")).resolves.toMatchObject({ installed: true, appId: "com.example.app" });
    expect(calls.slice(1)).toEqual([`adb -s emulator-5554 install -r ${build.path}`, "adb -s emulator-5554 shell pm path com.example.app"]);
  });

  it("adb 가 Failure 를 출력하면 종료 코드가 0 이어도 실패로 본다", async () => {
    const apk = join(dir, "app.apk");
    writeFileSync(apk, "PK");
    const { run } = recorder({
      aapt2: { code: 0, stdout: "package: name='com.example.app' versionCode='7' versionName='2.0.0'\n" },
      "adb -s emulator-5554 install": { code: 0, stdout: "Failure [INSTALL_FAILED_OLDER_SDK]\n" },
    });
    const s = service({ run });
    const build = await s.registerPath("example", apk);
    await expect(s.install(build.id, "qa_pixel")).rejects.toThrow(/INSTALL_FAILED_OLDER_SDK/);
  });

  it("꺼진 기기, 플랫폼이 다른 기기, 없는 빌드는 거부한다", async () => {
    const { run } = recorder();
    const s = service({ run, devices: [{ ...IOS, state: "shutdown" }, ANDROID] });
    const build = await s.registerPath("sample", makeFakeApp(join(dir, "src")));
    await expect(s.install(build.id, "UDID-1")).rejects.toThrow(/실행 중이 아니다/);
    await expect(s.install(build.id, "qa_pixel")).rejects.toThrow(/기기를 찾지 못했다/);
    await expect(s.install("nope", "UDID-1")).rejects.toThrow(/빌드를 찾지 못했다/);
  });
});
