import { GitHubProvider } from "@qa/remote";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub } from "../../../../../packages/remote/src/testing/fake-github";
import type { CommandRunner } from "../setup/command";
import { isNewer, parseVersion, UpdateError, UpdateService } from "./update-service";

const TOKEN = "ghp_fake_token_for_update_tests_00000000";
const DMG = Buffer.from("fake dmg 0.2.0");
const SUM = `${createHash("sha256").update(DMG).digest("hex")}  Avocado-0.2.0-arm64.dmg\n`;
let fake: FakeGitHub | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function setup(assets: { name: string; content: Buffer }[], opts: { current?: string; spctlCode?: number; codesignCode?: number; token?: string | null; team?: string | null } = {}) {
  fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/avocado": { push: false } }, publicRepos: ["acme/avocado"], release: { tag: "v0.2.0", assets } });
  const token = opts.token === undefined ? TOKEN : opts.token;
  const dir = mkdtempSync(join(tmpdir(), "qa-update-"));
  const opened: string[] = [];
  const shown: string[] = [];
  const calls: string[][] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
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
  });
  return { service, opened, shown, calls, dir };
}

const RELEASE = [
  { name: "Avocado-0.2.0-arm64.dmg", content: DMG },
  { name: "Avocado-0.2.0-arm64.dmg.sha256", content: Buffer.from(SUM) },
];

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
    expect(existsSync(join(bad.dir, "updates")) ? readdirSync(join(bad.dir, "updates")) : []).toEqual([]);
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
