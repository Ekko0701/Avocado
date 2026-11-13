import type { Device, IosDeviceCheck, IosDeviceReadiness, IosSigningTeam } from "@qa/shared";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../setup/command";
import { AgentDeviceError, type AgentDevice } from "./agent-device";
import { appsCount, parseDevicectlDevices, parseDevToolsSecurity, parseLockState, parseValidIdentityHashes, signingTeamsFromPems, type PhysicalIosDevice } from "./ios-device";

export class IosDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IosDeviceError";
  }
}

export interface IosDeviceServiceOptions {
  run: CommandRunner;
  agentDevice: AgentDevice;
  /** 설정의 서명 팀 ID. 정하지 않았으면 null */
  signingTeam: () => string | null;
  /** agent-device 가 설치돼 있는지 */
  toolInstalled: () => boolean;
  /** agent-device 를 설치한다(고정 버전·SHA-256 확인) */
  installTool: () => Promise<void>;
  now?: () => Date;
}

/**
 * iOS 실기기(ADR 0034). 목록·서명 팀·준비 점검·러너 준비를 맡는다.
 * 사람의 폰이라 설정을 바꾸지 않는다. 개발자 모드·Mac 보안 설정·잠금은 점검해 안내만 한다(ADR 0030 과 같다)
 */
export class IosDeviceService {
  constructor(private readonly options: IosDeviceServiceOptions) {}

  /** devicectl 이 JSON 을 파일로만 쓰므로 임시 파일을 거친다 */
  private async devicectlJson(args: string[], timeoutMs = 60_000): Promise<unknown> {
    const dir = mkdtempSync(join(tmpdir(), "avocado-devicectl-"));
    const out = join(dir, "out.json");
    try {
      const r = await this.options.run("/usr/bin/xcrun", ["devicectl", ...args, "--quiet", "--json-output", out], { timeoutMs });
      if (r.code !== 0) throw new IosDeviceError(`devicectl ${args.slice(0, 2).join(" ")} 실패: ${r.stderr.trim().slice(0, 300)}`);
      return JSON.parse(readFileSync(out, "utf8")) as unknown;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async physical(): Promise<PhysicalIosDevice[]> {
    return parseDevicectlDevices(await this.devicectlJson(["list", "devices"]));
  }

  /** 연결된 iPhone·iPad(실기기). 쓸 수 있으면 booted, 아니면 unknown */
  async list(): Promise<Device[]> {
    return (await this.physical()).map((p) => p.device);
  }

  /** iPhone 에 이 번들 ID 의 앱이 설치돼 있는지(TestFlight·App Store·Xcode 로 설치한 앱) */
  async isAppInstalled(id: string, bundleId: string): Promise<boolean> {
    return appsCount(await this.devicectlJson(["device", "info", "apps", "--device", id, "--bundle-id", bundleId, "--include-default-apps"])) > 0;
  }

  /** 지금 화면을 PNG 로 찍는다(실패 직후 캡처). 앱을 다시 띄우지 않는다 */
  async screenshot(id: string, dest: string): Promise<void> {
    const r = await this.options.run("/usr/bin/xcrun", ["devicectl", "device", "capture", "screenshot", "--device", id, "--destination", dest, "--quiet"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new IosDeviceError(`iPhone 화면을 찍지 못했다: ${r.stderr.trim().slice(0, 300)}`);
  }

  /** 이 Mac 키체인의 Apple Development 인증서로 서명할 수 있는 팀 */
  async signingTeams(): Promise<IosSigningTeam[]> {
    const identities = await this.options.run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    if (identities.code !== 0) throw new IosDeviceError(`서명 인증서 목록을 읽지 못했다: ${identities.stderr.trim().slice(0, 300)}`);
    const certs = await this.options.run("/usr/bin/security", ["find-certificate", "-a", "-p", "-c", "Apple Development"]);
    // 인증서가 하나도 없으면 security 가 실패 코드로 끝난다. 그때는 빈 목록이다
    if (certs.code !== 0 && /could not be found/i.test(certs.stderr)) return [];
    if (certs.code !== 0) throw new IosDeviceError(`서명 인증서를 읽지 못했다: ${certs.stderr.trim().slice(0, 300)}`);
    return signingTeamsFromPems(certs.stdout, parseValidIdentityHashes(identities.stdout), (this.options.now ?? (() => new Date()))());
  }

  /**
   * 실행 전에 볼 것: 연결, 기기 개발자 모드, Mac 개발 도구 보안, 잠금, 서명 팀, 도구.
   * buildRunner 면 모두 통과한 뒤 도구를 설치하고 러너를 서명·빌드해 올린다
   */
  async check(id: string, buildRunner: boolean): Promise<IosDeviceReadiness> {
    const checks: IosDeviceCheck[] = [];
    const add = (c: IosDeviceCheck) => checks.push(c);
    const phone = (await this.physical()).find((p) => p.device.id === id);
    if (!phone) throw new IosDeviceError(`iPhone 을 찾지 못했다: ${id}. 케이블로 연결하고 새로고침한다`);

    add({
      id: "connected",
      label: "연결",
      ok: phone.paired && phone.connected,
      detail: !phone.paired
        ? "이 Mac 과 짝지어져 있지 않다. 케이블로 연결하고 iPhone 에서 '이 컴퓨터 신뢰'를 누른다"
        : phone.connected
          ? `${phone.device.name} (iOS ${phone.device.osVersion})`
          : "연결이 끊겨 있다. 케이블로 연결하고 잠금을 푼다",
    });
    add({
      id: "developerMode",
      label: "iPhone 개발자 모드",
      ok: phone.developerMode === true,
      detail: phone.developerMode === true ? "켜짐" : "설정 → 개인정보 보호 및 보안 → 개발자 모드를 켜고 재시동한다",
    });
    const dts = await this.options.run("/usr/sbin/DevToolsSecurity", ["-status"]);
    const devTools = parseDevToolsSecurity(`${dts.stdout}\n${dts.stderr}`);
    add({
      id: "devToolsSecurity",
      label: "Mac 개발 도구 보안",
      ok: devTools,
      detail: devTools ? "켜짐" : "터미널에서 sudo DevToolsSecurity -enable 을 실행한다(관리자 암호가 필요하다)",
    });
    let locked: boolean | null = null;
    if (phone.connected) locked = parseLockState(await this.devicectlJson(["device", "info", "lockState", "--device", id]));
    add({
      id: "unlocked",
      label: "잠금 해제",
      ok: locked === false,
      detail: locked === false ? "잠금 해제됨" : locked === null ? "연결된 뒤 확인한다" : "iPhone 잠금을 풀어 둔다. 실행하는 동안 잠기면 실패한다",
    });
    const team = this.options.signingTeam();
    const teams = team ? await this.signingTeams() : [];
    const teamName = teams.find((t) => t.id === team)?.name;
    add({
      id: "signingTeam",
      label: "러너 서명 팀",
      ok: Boolean(team && teamName),
      detail: !team ? "설정 → 기기 → 러너 서명 팀에서 서명할 Apple 팀을 고르고 저장한다" : teamName ? `${teamName} (${team})` : `이 Mac 키체인에 팀 ${team} 의 Apple Development 인증서가 없다`,
    });
    add({
      id: "tool",
      label: "agent-device",
      ok: this.options.toolInstalled(),
      detail: this.options.toolInstalled() ? "설치됨" : "준비하면 고정 버전을 내려받아 설치한다(약 2MB)",
    });

    const blocking = checks.filter((c) => !c.ok && c.id !== "tool");
    if (buildRunner && blocking.length === 0 && team) {
      if (!this.options.toolInstalled()) {
        await this.options.installTool();
        const tool = checks.find((c) => c.id === "tool");
        if (tool) Object.assign(tool, { ok: true, detail: "설치함" });
      }
      try {
        await this.options.agentDevice.prepareRunner(id, team);
        add({ id: "runner", label: "러너", ok: true, detail: "서명·설치하고 응답을 확인했다" });
      } catch (error) {
        if (!(error instanceof AgentDeviceError)) throw error;
        add({ id: "runner", label: "러너", ok: false, detail: error.message });
      }
    }
    return { deviceId: id, checks, ready: checks.every((c) => c.ok) };
  }
}
