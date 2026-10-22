import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../setup/command";
import { BuildFormatError, findAapt2, parseAaptBadging, readIosAppMetadata } from "./metadata";
import { makeFakeApp } from "../../../test-support/fake-builds";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-meta-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("iOS .app 메타데이터", () => {
  it("Info.plist 에서 번들 ID·버전·빌드 번호를 읽는다", async () => {
    const app = makeFakeApp(dir, { bundleId: "com.example.sample.dev", version: "1.2.3", build: "1" });
    await expect(readIosAppMetadata(app, runCommand)).resolves.toEqual({ appId: "com.example.sample.dev", version: "1.2.3", buildNumber: "1" });
  });

  it("실기기용(iPhoneOS) 빌드는 거부한다", async () => {
    const app = makeFakeApp(dir, { platform: "iPhoneOS" });
    await expect(readIosAppMetadata(app, runCommand)).rejects.toThrow(/시뮬레이터용 빌드가 아니다/);
  });

  it("Info.plist 가 없으면 거부한다", async () => {
    mkdirSync(join(dir, "Empty.app"));
    await expect(readIosAppMetadata(join(dir, "Empty.app"), runCommand)).rejects.toBeInstanceOf(BuildFormatError);
  });
});

describe("APK 메타데이터", () => {
  it("aapt2 dump badging 첫 줄을 읽는다", () => {
    const out = "package: name='com.example.app' versionCode='120' versionName='1.2.0' platformBuildVersionName='15'\nsdkVersion:'26'\n";
    expect(parseAaptBadging(out)).toEqual({ appId: "com.example.app", version: "1.2.0", buildNumber: "120" });
  });

  it("package 줄이 없으면 거부한다", () => {
    expect(() => parseAaptBadging("ERROR: dump failed")).toThrow(BuildFormatError);
  });

  it("가장 새 build-tools 의 aapt2 를 숫자 순으로 고른다", () => {
    for (const v of ["9.0.0", "36.0.0", "34.0.0-rc1", "35.0.1"]) {
      mkdirSync(join(dir, "build-tools", v), { recursive: true });
      writeFileSync(join(dir, "build-tools", v, "aapt2"), "");
      chmodSync(join(dir, "build-tools", v, "aapt2"), 0o755);
    }
    expect(findAapt2(dir)).toBe(join(dir, "build-tools", "36.0.0", "aapt2"));
    expect(findAapt2(join(dir, "none"))).toBeNull();
  });
});
