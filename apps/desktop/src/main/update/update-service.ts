import type { RemoteProvider, RepoRef } from "@qa/remote";
import type { UpdateStatus } from "@qa/shared";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandRunner } from "../setup/command";

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateServiceOptions {
  remote: Pick<RemoteProvider, "getLatestRelease" | "downloadReleaseAsset">;
  /** 새 버전을 받는 배포 저장소(trust.ts). 워크스페이스 조직 설정과 상관없다 */
  releaseRepo: RepoRef;
  /** app.getVersion() */
  currentVersion: string;
  /** process.arch (arm64 우선, PLAN 11장) */
  arch: string;
  /** userData/updates */
  updatesDir: string;
  run: CommandRunner;
  /** shell.openPath. 빈 문자열이면 성공 */
  openPath(path: string): Promise<string>;
  /** shell.showItemInFolder */
  showItemInFolder(path: string): void;
  /** 열어도 되는 서명자 팀 ID(trust.ts). null 이면 열지 않는다 */
  signerTeamId: string | null;
  now?: () => Date;
}

const MAX_DMG_BYTES = 800 * 1024 * 1024;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/** v1.2.3 → [1,2,3]. 형식이 아니면 null(미리보기 태그 등은 무시) */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * 새 버전 확인(PLAN 11장): 시작할 때와 하루 한 번 배포 저장소의 최신 릴리스를 본다. 자동 설치는 하지 않는다(M2).
 * 사용자가 받기를 누르면 .dmg 와 .sha256 을 받아 SHA-256 을 맞춰 보고, 서명·공증이 확인된 것만 연다(PLAN 10.4).
 * 서명이 없으면(D12 전) 열지 않고 Finder 에서 보여 준다.
 */
export class UpdateService {
  private state: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  private release: Awaited<ReturnType<RemoteProvider["getLatestRelease"]>> = null;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = { current: options.currentVersion, source: `${options.releaseRepo.owner}/${options.releaseRepo.repo}`, latest: null, available: false, checkedAt: null, release: null, asset: null, error: null, downloaded: null, busy: false };
  }

  status(): UpdateStatus {
    return { ...this.state };
  }

  /** 시작 직후 한 번, 그 뒤 하루마다. 실패는 상태에 남긴다(앱 사용을 막지 않는다) */
  schedule(firstDelayMs = 5_000): void {
    const tick = () => void this.check().catch(() => undefined);
    setTimeout(tick, firstDelayMs).unref?.();
    this.timer = setInterval(tick, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<UpdateStatus> {
    const repo = this.options.releaseRepo;
    try {
      const release = await this.options.remote.getLatestRelease(repo);
      this.release = release;
      const asset = release ? this.pickDmg(release) : null;
      const latest = release?.tag ?? null;
      this.state = {
        ...this.state,
        latest,
        available: latest !== null && asset !== null && isNewer(latest, this.options.currentVersion),
        release: release ? { tag: release.tag, name: release.name, url: release.url, publishedAt: release.publishedAt } : null,
        asset: asset ? { name: asset.name, size: asset.size } : null,
        // 404 는 정식 릴리스가 없는 경우다. 조용히 넘기지 않고 알린다
        error: !release
          ? `${repo.owner}/${repo.repo} 에 정식 릴리스가 없다(미리보기 릴리스는 확인하지 않는다)`
          : !asset
            ? `이 Mac(${this.options.arch})용 ${release.tag} .dmg 가 릴리스에 없다`
            : null,
        checkedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      };
    } catch (error) {
      this.state = { ...this.state, error: error instanceof Error ? error.message : String(error), checkedAt: (this.options.now ?? (() => new Date()))().toISOString() };
    }
    return this.status();
  }

  async download(): Promise<UpdateStatus> {
    if (this.state.busy) throw new UpdateError("이미 받고 있다");
    const release = this.release;
    const asset = release ? this.pickDmg(release) : null;
    if (!release || !asset || !this.state.available) throw new UpdateError("받을 새 버전이 없다. 먼저 확인한다");
    const sumAsset = release.assets.find((a) => a.name === `${asset.name}.sha256`);
    if (!sumAsset) throw new UpdateError(`${asset.name}.sha256 이 릴리스에 없어 받지 않는다`);
    const repo = this.options.releaseRepo;
    this.state = { ...this.state, busy: true, error: null };
    const file = join(this.options.updatesDir, basename(asset.name));
    try {
      const sumText = (await this.options.remote.downloadReleaseAsset(repo, sumAsset, 4096)).toString("utf8");
      const expected = /\b([0-9a-f]{64})\b/i.exec(sumText)?.[1]?.toLowerCase();
      if (!expected) throw new UpdateError(".sha256 파일 형식이 아니다");
      const dmg = await this.options.remote.downloadReleaseAsset(repo, asset, MAX_DMG_BYTES);
      const actual = createHash("sha256").update(dmg).digest("hex");
      if (actual !== expected) throw new UpdateError("받은 파일의 SHA-256 이 릴리스와 다르다. 열지 않는다");
      mkdirSync(this.options.updatesDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, dmg, { mode: 0o600 });
      // 서명·공증(Gatekeeper) + 우리 팀의 서명인지. 둘 다 통과한 것만 연다
      const signed = await this.trusted(file);
      let opened = false;
      if (signed) {
        const err = await this.options.openPath(file);
        if (err) throw new UpdateError(`설치 파일을 열지 못했다: ${err}`);
        opened = true;
      } else {
        this.options.showItemInFolder(file);
      }
      this.state = {
        ...this.state,
        busy: false,
        downloaded: { file: basename(file), verified: true, signed, opened },
        error: signed
          ? null
          : this.options.signerTeamId
            ? "서명·공증 또는 팀 서명이 확인되지 않아 열지 않았다. 출처를 확인한다"
            : "업데이트 서명자(팀 ID)가 정해지지 않아(D12) 열지 않았다. 설치 가이드의 절차로 직접 설치한다",
      };
    } catch (error) {
      rmSync(file, { force: true });
      this.state = { ...this.state, busy: false, error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
    return this.status();
  }

  /** 이 Mac 아키텍처 이름과 태그 버전이 모두 들어 있는 .dmg 만(다른 아키텍처·다른 버전 파일을 고르지 않는다) */
  private pickDmg(release: { tag: string; assets: { id: number; name: string; url: string; size: number }[] }): { id: number; name: string; url: string; size: number } | null {
    const version = parseVersion(release.tag)?.join(".");
    if (!version) return null;
    return release.assets.find((a) => a.name.endsWith(".dmg") && a.name.includes(`-${version}-`) && a.name.includes(this.options.arch)) ?? null;
  }

  private async trusted(file: string): Promise<boolean> {
    const team = this.options.signerTeamId;
    if (!team || !/^[A-Z0-9]{10}$/.test(team)) return false;
    const assess = await this.options.run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", file], { timeoutMs: 120_000 });
    if (assess.code !== 0) return false;
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
    const verify = await this.options.run("/usr/bin/codesign", ["--verify", `-R${requirement}`, file], { timeoutMs: 120_000 });
    return verify.code === 0;
  }
}
