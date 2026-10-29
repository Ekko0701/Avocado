import type { Release, RemoteProvider, RepoRef } from "@qa/remote";
import type { UpdateStatus } from "@qa/shared";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandRunner } from "../setup/command";

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

/** 받은 .zip 으로 실행 중인 앱을 바꿔 끼운다(native-updater.ts, ADR 0027) */
export interface AppInstaller {
  /** 이 앱이 스스로 바꿔 끼울 수 없는 이유(패키징 안 됨, 응용 프로그램 폴더 밖 등). 없으면 null */
  blocker(): string | null;
  /** 확인을 마친 .zip 을 넘겨 적용 준비를 한다. 끝나면 재시작으로 적용된다 */
  prepare(zipFile: string): Promise<void>;
  /** 앱을 끝내고 준비한 업데이트를 적용한 뒤 다시 연다 */
  quitAndInstall(): void;
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
  installer: AppInstaller;
  /** 재시작하면 끊기는 작업(실행·플로우 만들기·빌드)이 있으면 그 이유. 없으면 null */
  busy(): string | null;
  now?: () => Date;
}

type Asset = Release["assets"][number];

const MAX_DOWNLOAD_BYTES = 800 * 1024 * 1024;
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
 * 새 버전 확인(PLAN 11장): 시작할 때와 하루 한 번 배포 저장소의 최신 릴리스를 본다.
 * 받기를 누르면 릴리스의 .sha256 으로 SHA-256 을 맞춰 보고, 서명·공증·팀 서명이 확인된 것만 쓴다(PLAN 10.4).
 * - 재시작으로 적용(ADR 0027): 릴리스에 이 Mac 용 .zip 이 있고 앱이 스스로 바꿔 끼울 수 있으면, 풀어서 확인한 뒤
 *   Squirrel.Mac 에 넘긴다. 사용자가 재시작을 누르면 적용된다.
 * - 아니면 .dmg 를 받아 연다. 서명이 확인되지 않으면 열지 않고 Finder 에서 보여 준다.
 */
export class UpdateService {
  private state: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  private release: Release | null = null;
  /** Squirrel.Mac 에 넘겨 둔 릴리스 태그. 재시작하면 적용된다 */
  private prepared: string | null = null;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = {
      current: options.currentVersion,
      source: `${options.releaseRepo.owner}/${options.releaseRepo.repo}`,
      latest: null,
      available: false,
      checkedAt: null,
      release: null,
      asset: null,
      error: null,
      downloaded: null,
      autoInstall: { possible: false, reason: null, ready: false },
      busy: false,
    };
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
      const asset = release ? this.pickAsset(release, ".dmg") : null;
      const latest = release?.tag ?? null;
      const available = latest !== null && asset !== null && isNewer(latest, this.options.currentVersion);
      const blocker = release && available ? this.autoInstallBlocker(release) : null;
      this.state = {
        ...this.state,
        latest,
        available,
        release: release ? { tag: release.tag, name: release.name, url: release.url, publishedAt: release.publishedAt } : null,
        asset: asset ? { name: asset.name, size: asset.size } : null,
        // 404 는 정식 릴리스가 없는 경우다. 조용히 넘기지 않고 알린다
        error: !release
          ? `${repo.owner}/${repo.repo} 에 정식 릴리스가 없다(미리보기 릴리스는 확인하지 않는다)`
          : !asset
            ? `이 Mac(${this.options.arch})용 ${release.tag} .dmg 가 릴리스에 없다`
            : null,
        autoInstall: { possible: available && blocker === null, reason: blocker, ready: available && this.prepared === latest },
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
    if (!release || !this.state.available) throw new UpdateError("받을 새 버전이 없다. 먼저 확인한다");
    // 확인한 뒤 앱을 옮겼을 수 있어 다시 본다
    const blocker = this.autoInstallBlocker(release);
    this.state = { ...this.state, autoInstall: { ...this.state.autoInstall, possible: blocker === null, reason: blocker } };
    return blocker === null ? this.prepareRestart(release) : this.downloadDmg(release);
  }

  /** 받아 둔 업데이트를 적용한다: 앱을 끝내고 바꿔 끼운 뒤 다시 연다 */
  install(): UpdateStatus {
    if (!this.state.autoInstall.ready) throw new UpdateError("재시작해서 적용할 업데이트가 없다. 먼저 받는다");
    const busy = this.options.busy();
    if (busy) throw new UpdateError(`${busy}. 끝난 뒤 재시작한다`);
    this.options.installer.quitAndInstall();
    return this.status();
  }

  /** .zip 을 받아 풀어서 확인하고 Squirrel.Mac 에 넘긴다. 재시작은 사용자가 누른다 */
  private async prepareRestart(release: Release): Promise<UpdateStatus> {
    const zip = this.pickAsset(release, ".zip");
    const sumAsset = zip ? release.assets.find((a) => a.name === `${zip.name}.sha256`) : undefined;
    if (!zip || !sumAsset) throw new UpdateError(`${release.tag} 에 .zip·.sha256 이 없다`);
    const version = parseVersion(release.tag)?.join(".");
    if (!version) throw new UpdateError(`버전 태그가 아니다: ${release.tag}`);
    this.state = { ...this.state, busy: true, error: null };
    const file = join(this.options.updatesDir, basename(zip.name));
    const unpacked = join(this.options.updatesDir, "unpacked");
    try {
      const data = await this.downloadVerified(zip, sumAsset);
      mkdirSync(this.options.updatesDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, data, { mode: 0o600 });
      // 풀어서 본다: 릴리스 버전의 앱이고, 우리 팀이 서명·공증했다. Squirrel.Mac 도 지금 앱과 같은 서명 요건인지 다시 본다
      rmSync(unpacked, { recursive: true, force: true });
      mkdirSync(unpacked, { mode: 0o700 });
      const extract = await this.options.run("/usr/bin/ditto", ["-x", "-k", file, unpacked], { timeoutMs: 300_000 });
      if (extract.code !== 0) throw new UpdateError(`.zip 을 풀지 못했다: ${extract.stderr.trim()}`);
      const apps = readdirSync(unpacked).filter((name) => name.endsWith(".app"));
      if (apps.length !== 1 || !apps[0]) throw new UpdateError(`.zip 에 앱이 ${apps.length}개 있다(1개여야 한다)`);
      const appPath = join(unpacked, apps[0]);
      const plist = await this.options.run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")], { timeoutMs: 30_000 });
      const inside = plist.code === 0 ? plist.stdout.trim() : "";
      if (inside !== version) throw new UpdateError(`.zip 안 앱의 버전(${inside || "읽지 못함"})이 ${release.tag} 와 다르다`);
      if (!(await this.trusted(appPath, "exec"))) throw new UpdateError(".zip 안 앱의 서명·공증 또는 팀 서명이 확인되지 않아 적용하지 않는다");
      await this.options.installer.prepare(file);
      this.prepared = release.tag;
      this.state = { ...this.state, busy: false, error: null, autoInstall: { possible: true, reason: null, ready: true } };
      return this.status();
    } catch (error) {
      this.state = { ...this.state, busy: false, error: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      // Squirrel.Mac 은 준비할 때 자기 사본을 받아 두므로 지운다
      rmSync(file, { force: true });
      rmSync(unpacked, { recursive: true, force: true });
    }
  }

  /** .dmg 를 받아 확인된 것만 연다(앱을 응용 프로그램 폴더 밖에서 실행했거나 .zip 이 없는 릴리스) */
  private async downloadDmg(release: Release): Promise<UpdateStatus> {
    const asset = this.pickAsset(release, ".dmg");
    if (!asset) throw new UpdateError("받을 새 버전이 없다. 먼저 확인한다");
    const sumAsset = release.assets.find((a) => a.name === `${asset.name}.sha256`);
    if (!sumAsset) throw new UpdateError(`${asset.name}.sha256 이 릴리스에 없어 받지 않는다`);
    this.state = { ...this.state, busy: true, error: null };
    const file = join(this.options.updatesDir, basename(asset.name));
    try {
      const dmg = await this.downloadVerified(asset, sumAsset);
      mkdirSync(this.options.updatesDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, dmg, { mode: 0o600 });
      // 서명·공증(Gatekeeper) + 우리 팀의 서명인지. 둘 다 통과한 것만 연다
      const signed = await this.trusted(file, "open");
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

  /** 릴리스의 <파일>.sha256 과 SHA-256 이 같은 내용만 돌려준다 */
  private async downloadVerified(asset: Asset, sumAsset: Asset): Promise<Buffer> {
    const repo = this.options.releaseRepo;
    const sumText = (await this.options.remote.downloadReleaseAsset(repo, sumAsset, 4096)).toString("utf8");
    const expected = /\b([0-9a-f]{64})\b/i.exec(sumText)?.[1]?.toLowerCase();
    if (!expected) throw new UpdateError(".sha256 파일 형식이 아니다");
    const data = await this.options.remote.downloadReleaseAsset(repo, asset, MAX_DOWNLOAD_BYTES);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) throw new UpdateError("받은 파일의 SHA-256 이 릴리스와 다르다. 쓰지 않는다");
    return data;
  }

  /** 재시작으로 적용할 수 없는 이유. 없으면 null */
  private autoInstallBlocker(release: Release): string | null {
    if (!this.options.signerTeamId) return "업데이트 서명자(팀 ID)가 정해지지 않아 재시작해서 업데이트할 수 없다";
    const zip = this.pickAsset(release, ".zip");
    if (!zip || !release.assets.some((a) => a.name === `${zip.name}.sha256`)) return `${release.tag} 에 이 Mac(${this.options.arch})용 .zip 이 없어 설치 파일(.dmg)로 받는다`;
    return this.options.installer.blocker();
  }

  /** 이 Mac 아키텍처 이름과 태그 버전이 모두 들어 있는 파일만(다른 아키텍처·다른 버전 파일을 고르지 않는다) */
  private pickAsset(release: Release, ext: ".dmg" | ".zip"): Asset | null {
    const version = parseVersion(release.tag)?.join(".");
    if (!version) return null;
    return release.assets.find((a) => a.name.endsWith(ext) && a.name.includes(`-${version}-`) && a.name.includes(this.options.arch)) ?? null;
  }

  /** Gatekeeper(서명·공증) + 정해 둔 팀의 서명. dmg 는 open, 앱은 exec 로 평가한다 */
  private async trusted(path: string, type: "open" | "exec"): Promise<boolean> {
    const team = this.options.signerTeamId;
    if (!team || !/^[A-Z0-9]{10}$/.test(team)) return false;
    const assessArgs = type === "open" ? ["--assess", "--type", "open", "--context", "context:primary-signature", path] : ["--assess", "--type", "exec", path];
    const assess = await this.options.run("/usr/sbin/spctl", assessArgs, { timeoutMs: 120_000 });
    if (assess.code !== 0) return false;
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
    const verify = await this.options.run("/usr/bin/codesign", ["--verify", `-R${requirement}`, path], { timeoutMs: 120_000 });
    return verify.code === 0;
  }
}
