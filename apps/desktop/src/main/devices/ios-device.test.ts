import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appsCount, parseDevicectlDevices, parseDevToolsSecurity, parseLockState, parseValidIdentityHashes, runnerBundleId, signingTeamsFromPems } from "./ios-device";

/** devicectl list devices --json-output 모양(2026-11-12 Xcode 27.2 에서 본 칸만, 이름은 가짜) */
const LIST = {
  info: { outcome: "success" },
  result: {
    devices: [
      { hardwareProperties: { udid: "65C8470A-3B2A-4B20-A381-EF39C0C6A45E", platform: "iOS", reality: "simulated", deviceType: "iPhone" }, deviceProperties: { name: "Avocado iPhone 17 (iOS 27.2)", osVersionNumber: "27.2" }, connectionProperties: { pairingState: "paired", tunnelState: "disconnected" } },
      { hardwareProperties: { udid: "00008006-0002F5AE228B402E", platform: "watchOS", reality: null, deviceType: "appleWatch" }, deviceProperties: { name: "Watch" }, connectionProperties: { pairingState: "paired", tunnelState: "unavailable" } },
      { hardwareProperties: { udid: "00008101-00191D961A11A01E", platform: "iOS", reality: "physical", deviceType: "iPad", marketingName: "iPad (10th generation)" }, deviceProperties: { name: "테스트 iPad", osVersionNumber: "26.2", developerModeStatus: "enabled" }, connectionProperties: { pairingState: "paired", tunnelState: "disconnected" } },
      { hardwareProperties: { udid: "00008160-001C79811EA80036", platform: "iOS", reality: "physical", deviceType: "iPhone", marketingName: "iPhone 18 Pro" }, deviceProperties: { name: "테스트 iPhone", osVersionNumber: "27.0.1", developerModeStatus: "enabled" }, connectionProperties: { pairingState: "paired", tunnelState: "connected" } },
      { hardwareProperties: { udid: "00008110-000A1B2C3D4E5F60", platform: "iOS", reality: "physical", deviceType: "iPhone" }, deviceProperties: { name: "개발자 모드 끈 폰", osVersionNumber: "26.0", developerModeStatus: "disabled" }, connectionProperties: { pairingState: "paired", tunnelState: "connected" } },
    ],
  },
};

describe("parseDevicectlDevices", () => {
  it("실제 iPhone·iPad 만 뽑고, 연결·개발자 모드가 갖춰진 것만 booted", () => {
    const out = parseDevicectlDevices(LIST);
    expect(out.map((p) => [p.device.name, p.device.state, p.developerMode])).toEqual([
      ["테스트 iPad", "unknown", true],
      ["테스트 iPhone", "booted", true],
      ["개발자 모드 끈 폰", "unknown", false],
    ]);
    expect(out[1]?.device).toMatchObject({ id: "00008160-001C79811EA80036", platform: "ios", kind: "real", osVersion: "27.0.1", managed: false, serial: null });
  });

  it("실패 결과나 다른 형식은 빈 목록이 아니라 예외", () => {
    expect(() => parseDevicectlDevices({ info: { outcome: "failed" }, result: { devices: [] } })).toThrow(/실패/);
    expect(() => parseDevicectlDevices({ result: {} })).toThrow();
  });
});

describe("잠금·Mac 보안·앱", () => {
  it("lockState 의 passcodeRequired", () => {
    expect(parseLockState({ info: { outcome: "success" }, result: { passcodeRequired: true, unlockedSinceBoot: true } })).toBe(true);
    expect(parseLockState({ info: { outcome: "success" }, result: { passcodeRequired: false } })).toBe(false);
    expect(() => parseLockState({ info: { outcome: "success" }, result: {} })).toThrow();
  });

  it("DevToolsSecurity -status", () => {
    expect(parseDevToolsSecurity("Developer mode is currently enabled.\n")).toBe(true);
    expect(parseDevToolsSecurity("Developer mode is currently disabled.\n")).toBe(false);
    expect(() => parseDevToolsSecurity("??")).toThrow();
  });

  it("devicectl device info apps 의 앱 수", () => {
    expect(appsCount({ info: { outcome: "success" }, result: { apps: [{ bundleIdentifier: "com.example.demo" }] } })).toBe(1);
    expect(appsCount({ info: { outcome: "success" }, result: { apps: [] } })).toBe(0);
  });
});

describe("서명 팀", () => {
  function makeCert(dir: string, cn: string, ou: string, org: string, days: number): string {
    const key = join(dir, `${ou}.key`);
    const pem = join(dir, `${ou}.pem`);
    execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", pem, "-days", String(days), "-subj", `/CN=${cn}/OU=${ou}/O=${org}/C=US`], { stdio: "ignore" });
    return readFileSync(pem, "utf8");
  }
  const sha1 = (pem: string) =>
    execFileSync("/usr/bin/openssl", ["x509", "-noout", "-fingerprint", "-sha1"], { input: pem })
      .toString()
      .replace(/^.*=/, "")
      .replaceAll(":", "")
      .trim()
      .toUpperCase();

  it("유효한 서명 인증서의 OU·O 로 팀을 만들고, 키가 없거나 다른 종류는 뺀다", () => {
    const dir = mkdtempSync(join(tmpdir(), "certs-"));
    try {
      const personal = makeCert(dir, "Apple Development: Tester (QWERTY1234)", "TEAMAAAA11", "Demo Person", 30);
      const company = makeCert(dir, "Apple Development: Tester (ASDFGH5678)", "TEAMBBBB22", "Sample Inc", 30);
      const noKey = makeCert(dir, "Apple Development: Other (ZXCVBN9012)", "TEAMCCCC33", "No Key", 30);
      const devId = makeCert(dir, "Developer ID Application: Demo Person (TEAMAAAA11)", "TEAMDDDD44", "Demo Person", 30);
      const valid = new Set([sha1(personal), sha1(company), sha1(devId)]);
      const teams = signingTeamsFromPems([company, personal, noKey, devId, personal].join("\n"), valid, new Date());
      expect(teams).toEqual([
        { id: "TEAMAAAA11", name: "Demo Person" },
        { id: "TEAMBBBB22", name: "Sample Inc" },
      ]);
      // 기한이 지난 인증서는 뺀다
      expect(signingTeamsFromPems(personal, valid, new Date(Date.now() + 40 * 86_400_000))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("find-identity 출력의 SHA-1", () => {
    const out = '  1) B86E9233872849493F0FCE43CDD12C8BBEC7D897 "Apple Development: Demo (QWERTY1234)"\n  2) 0B271B15256A58547740D354D2C05448B33A91CC "Developer ID Application: Demo (TEAMAAAA11)"\n     2 valid identities found\n';
    expect([...parseValidIdentityHashes(out)]).toEqual(["B86E9233872849493F0FCE43CDD12C8BBEC7D897", "0B271B15256A58547740D354D2C05448B33A91CC"]);
  });

  it("러너 번들 ID 는 팀마다 다르다", () => {
    expect(runnerBundleId("TEAMAAAA11")).toBe("dev.avocado.agentdevice.teamaaaa11.runner");
  });
});
