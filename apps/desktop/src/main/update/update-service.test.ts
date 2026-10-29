import { GitHubProvider } from "@qa/remote";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub } from "../../../../../packages/remote/src/testing/fake-github";
import type { CommandRunner } from "../setup/command";
import { isNewer, parseVersion, UpdateError, UpdateService } from "./update-service";

const TOKEN = "ghp_fake_token_for_update_tests_00000000";
const DMG = Buffer.from("fake dmg 0.2.0");
const SUM = `${createHash("sha256").update(DMG).digest("hex")}  Avocado-0.2.0-arm64.dmg\n`;
const ZIP = Buffer.from("fake zip 0.2.0");
const ZIP_SUM = `${createHash("sha256").update(ZIP).digest("hex")}  Avocado-0.2.0-arm64.zip\n`;
let fake: FakeGitHub | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

interface SetupOptions {
  current?: string;
  spctlCode?: number;
  codesignCode?: number;
  token?: string | null;
  team?: string | null;
  /** .zip 안 앱의 CFBundleShortVersionString */
  appVersion?: string;
  /** 이 앱이 스스로 바꿔 끼울 수 없는 이유 */
  blocker?: string | null;
  prepareError?: Error;
  busy?: string | null;
}

async function setup(assets: { name: string; content: Buffer }[], opts: SetupOptions = {}) {
  fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/avocado": { push: false } }, publicRepos: ["acme/avocado"], release: { tag: "v0.2.0", assets } });
  const token = opts.token === undefined ? TOKEN : opts.token;
  const dir = mkdtempSync(join(tmpdir(), "qa-update-"));
  const opened: string[] = [];
  const shown: string[] = [];
  const calls: string[][] = [];
  const prepared: string[] = [];
  let installs = 0;
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    // ditto -x -k <zip> <폴더>: 앱 하나가 풀린 것처럼 만든다
    if (file.endsWith("ditto")) {
      mkdirSync(join(String(args[3]), "Avocado.app", "Contents"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (file.endsWith("plutil")) return { code: 0, stdout: `${opts.appVersion ?? "0.2.0"}\n`, stderr: "" };
    const code = file.endsWith("codesign") ? (opts.codesignCode ?? 0) : (opts.spctlCode ?? 0);
    return { code, stdout: "", stderr: code ? "rejected" : "accepted" };
  };
  const service = new UpdateService({
    remote: new GitHubProvider({ token: () => token, apiUrl: fake.url }),
    releaseRepo: { owner: "acme", repo: "avocado" },
    currentVersion: opts.current ?? "0.1.0",
    arch: "arm64",
    updatesDir: join(dir, "updates"),
    run,
    openPath: async (p) => {
      opened.push(p);
      return "";
    },
    showItemInFolder: (p) => shown.push(p),
    signerTeamId: opts.team === undefined ? "ABCDE12345" : opts.team,
    installer: {
      blocker: () => (opts.blocker === undefined ? null : opts.blocker),
      prepare: async (zip) => {
        if (opts.prepareError) throw opts.prepareError;
        prepared.push(zip);
      },
      quitAndInstall: () => {
        installs += 1;
      },
    },
    busy: () => opts.busy ?? null,
  });
  return { service, opened, shown, calls, prepared, installs: () => installs, dir };
}

const RELEASE = [
  { name: "Avocado-0.2.0-arm64.dmg", content: DMG },
  { name: "Avocado-0.2.0-arm64.dmg.sha256", content: Buffer.from(SUM) },
];
const WITH_ZIP = [...RELEASE, { name: "Avocado-0.2.0-arm64.zip", content: ZIP }, { name: "Avocado-0.2.0-arm64.zip.sha256", content: Buffer.from(ZIP_SUM) }];

function leftovers(dir: string): string[] {
  return existsSync(join(dir, "updates")) ? readdirSync(join(dir, "updates")) : [];
}

describe("새 버전 확인 (PLAN 11장)", () => {
  it("버전 비교", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v1.2.3-beta.1")).toBeNull();
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("nightly", "0.1.0")).toBe(false);
  });

  it("새 버전을 알리고, 받으면 SHA-256 을 맞춰 보고 서명이 확인된 것만 연다", async () => {
    const { service, opened, calls } = await setup(RELEASE);
    const status = await service.check();
    expect(status).toMatchObject({ current: "0.1.0", source: "acme/avocado", latest: "v0.2.0", available: true, asset: { name: "Avocado-0.2.0-arm64.dmg", size: DMG.length }, error: null });
    const done = await service.download();
    expect(done.downloaded).toEqual({ file: "Avocado-0.2.0-arm64.dmg", verified: true, signed: true, opened: true });
    expect(opened[0]).toMatch(/updates\/Avocado-0\.2\.0-arm64\.dmg$/);
    expect(calls[0]?.slice(0, 4)).toEqual(["/usr/sbin/spctl", "--assess", "--type", "open"]);
    // 공증만으로는 부족하다: 정해 둔 팀의 서명인지 본다
    expect(calls[1]?.[0]).toBe("/usr/bin/codesign");
    expect(calls[1]?.[2]).toBe('-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"');
  });

  it("다른 팀이 서명했거나 팀 ID 가 정해지지 않았으면(D12 전) 열지 않는다", async () => {
    const other = await setup(RELEASE, { codesignCode: 3 });
    await other.service.check();
    expect((await other.service.download()).downloaded).toMatchObject({ signed: false, opened: false });
    expect(other.opened).toEqual([]);
    await fake?.close();
    const unset = await setup(RELEASE, { team: null });
    await unset.service.check();
    const done = await unset.service.download();
    expect(done.downloaded).toMatchObject({ verified: true, signed: false, opened: false });
    expect(done.error).toContain("D12");
    expect(unset.calls).toEqual([]);
  });

  it("다른 아키텍처·다른 버전 이름의 dmg 는 고르지 않고, 릴리스가 없으면 알린다", async () => {
    const wrong = await setup([{ name: "Avocado-0.2.0-x64.dmg", content: DMG }, { name: "Avocado-0.1.9-arm64.dmg", content: DMG }]);
    const s1 = await wrong.service.check();
    expect(s1).toMatchObject({ available: false, asset: null });
    expect(s1.error).toContain("arm64");
  });

  it("서명·공증이 확인되지 않으면 열지 않고 Finder 로만 보여 준다(D12 전)", async () => {
    const { service, opened, shown } = await setup(RELEASE, { spctlCode: 3 });
    await service.check();
    const done = await service.download();
    expect(done.downloaded).toMatchObject({ verified: true, signed: false, opened: false });
    expect(opened).toEqual([]);
    expect(shown).toHaveLength(1);
    expect(done.error).toContain("서명");
  });

  it("SHA-256 이 다르거나 .sha256 이 없으면 받지 않고 파일을 남기지 않는다", async () => {
    const bad = await setup([RELEASE[0] as { name: string; content: Buffer }, { name: "Avocado-0.2.0-arm64.dmg.sha256", content: Buffer.from(`${"0".repeat(64)}  x\n`) }]);
    await bad.service.check();
    await expect(bad.service.download()).rejects.toThrow("SHA-256");
    expect(leftovers(bad.dir)).toEqual([]);
    await fake?.close();
    const noSum = await setup([RELEASE[0] as { name: string; content: Buffer }]);
    await noSum.service.check();
    await expect(noSum.service.download()).rejects.toThrow(UpdateError);
  });

  it("같은 버전이면 알리지 않는다", async () => {
    const same = await setup(RELEASE, { current: "0.2.0" });
    expect((await same.service.check()).available).toBe(false);
    await expect(same.service.download()).rejects.toThrow("받을 새 버전이 없다");
  });

  it("GitHub 토큰·워크스페이스 조직이 없어도 공개 배포 저장소에서 확인하고 받는다", async () => {
    const { service, opened } = await setup(RELEASE, { token: null });
    expect(await service.check()).toMatchObject({ source: "acme/avocado", latest: "v0.2.0", available: true, error: null });
    expect((await service.download()).downloaded).toMatchObject({ verified: true, signed: true, opened: true });
    expect(opened).toHaveLength(1);
    // 토큰 없이 부른 요청만 있다
    expect(fake?.requests.every((r) => !r.authorized)).toBe(true);
  });
});

describe("재시작으로 적용 (ADR 0027)", () => {
  it(".zip 이 있으면 받아 풀어서 확인하고 준비한 뒤, 재시작을 누르면 적용한다", async () => {
    const { service, opened, calls, prepared, installs, dir } = await setup(WITH_ZIP);
    expect((await service.check()).autoInstall).toEqual({ possible: true, reason: null, ready: false });
    const done = await service.download();
    expect(done.autoInstall).toEqual({ possible: true, reason: null, ready: true });
    expect(done.error).toBeNull();
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatch(/updates\/Avocado-0\.2\.0-arm64\.zip$/);
    // dmg 는 받지도 열지도 않는다
    expect(opened).toEqual([]);
    // 풀기 → 버전 → Gatekeeper(exec) → 팀 서명 순서로 본다
    expect(calls.map((c) => c[0])).toEqual(["/usr/bin/ditto", "/usr/bin/plutil", "/usr/sbin/spctl", "/usr/bin/codesign"]);
    expect(calls[2]?.slice(1, 4)).toEqual(["--assess", "--type", "exec"]);
    expect(calls[2]?.[4]).toMatch(/unpacked\/Avocado\.app$/);
    expect(calls[3]?.[2]).toBe('-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"');
    // 받은 .zip 과 푼 사본은 남기지 않는다(Squirrel.Mac 이 자기 사본을 둔다)
    expect(leftovers(dir)).toEqual([]);
    // 다시 확인해도 같은 릴리스면 준비된 그대로다
    expect((await service.check()).autoInstall.ready).toBe(true);
    service.install();
    expect(installs()).toBe(1);
  });

  it("앱이 스스로 바꿔 끼울 수 없으면 이유를 알리고 .dmg 로 받는다", async () => {
    const { service, opened, prepared } = await setup(WITH_ZIP, { blocker: "응용 프로그램 폴더에서 실행하지 않아 재시작해서 업데이트할 수 없다" });
    expect((await service.check()).autoInstall).toEqual({ possible: false, reason: "응용 프로그램 폴더에서 실행하지 않아 재시작해서 업데이트할 수 없다", ready: false });
    const done = await service.download();
    expect(done.downloaded).toMatchObject({ opened: true });
    expect(opened).toHaveLength(1);
    expect(prepared).toEqual([]);
  });

  it(".zip 이나 그 .sha256 이 없는 릴리스는 .dmg 로 받는다", async () => {
    const { service, prepared } = await setup([...RELEASE, { name: "Avocado-0.2.0-arm64.zip", content: ZIP }]);
    const status = await service.check();
    expect(status.autoInstall.possible).toBe(false);
    expect(status.autoInstall.reason).toContain(".zip");
    expect((await service.download()).downloaded).toMatchObject({ opened: true });
    expect(prepared).toEqual([]);
  });

  it(".zip 안 앱의 버전이 다르거나 서명·공증이 확인되지 않으면 적용하지 않고 파일을 남기지 않는다", async () => {
    const wrongVersion = await setup(WITH_ZIP, { appVersion: "0.1.9" });
    await wrongVersion.service.check();
    await expect(wrongVersion.service.download()).rejects.toThrow("버전(0.1.9)");
    expect(wrongVersion.prepared).toEqual([]);
    expect(wrongVersion.service.status().autoInstall.ready).toBe(false);
    expect(leftovers(wrongVersion.dir)).toEqual([]);
    await fake?.close();
    const unsigned = await setup(WITH_ZIP, { spctlCode: 3 });
    await unsigned.service.check();
    await expect(unsigned.service.download()).rejects.toThrow("서명·공증");
    expect(unsigned.prepared).toEqual([]);
    await fake?.close();
    const otherTeam = await setup(WITH_ZIP, { codesignCode: 3 });
    await otherTeam.service.check();
    await expect(otherTeam.service.download()).rejects.toThrow("팀 서명");
    expect(otherTeam.prepared).toEqual([]);
  });

  it("준비(Squirrel.Mac)가 실패하면 알리고 재시작할 수 없게 둔다", async () => {
    const { service, installs } = await setup(WITH_ZIP, { prepareError: new UpdateError("업데이트를 준비하지 못했다: code signature") });
    await service.check();
    await expect(service.download()).rejects.toThrow("준비하지 못했다");
    expect(service.status()).toMatchObject({ busy: false, autoInstall: { ready: false }, error: "업데이트를 준비하지 못했다: code signature" });
    expect(() => service.install()).toThrow("먼저 받는다");
    expect(installs()).toBe(0);
  });

  it("받기 전이거나 실행·플로우 만들기·빌드가 진행 중이면 재시작하지 않는다", async () => {
    const { service, installs } = await setup(WITH_ZIP, { busy: "플로우 실행이 진행 중이다" });
    await service.check();
    expect(() => service.install()).toThrow("먼저 받는다");
    await service.download();
    expect(() => service.install()).toThrow("플로우 실행이 진행 중이다. 끝난 뒤 재시작한다");
    expect(installs()).toBe(0);
  });
});
