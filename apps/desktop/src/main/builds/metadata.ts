import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../setup/command";

export interface AppMetadata {
  appId: string;
  version: string;
  buildNumber: string;
}

export class BuildFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildFormatError";
  }
}

const InfoPlistSchema = z.object({
  CFBundleIdentifier: z.string().min(1),
  CFBundleShortVersionString: z.string().optional(),
  CFBundleVersion: z.string().optional(),
  CFBundleSupportedPlatforms: z.array(z.string()).optional(),
});

/** 시뮬레이터용 .app 의 Info.plist 를 읽는다. 실기기용 빌드는 거부한다. */
export async function readIosAppMetadata(appDir: string, run: CommandRunner): Promise<AppMetadata> {
  const plist = join(appDir, "Info.plist");
  if (!existsSync(plist)) throw new BuildFormatError(".app 안에 Info.plist 가 없다");
  const r = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  if (r.code !== 0) throw new BuildFormatError(`Info.plist 를 읽지 못했다: ${r.stderr.trim()}`);
  const info = InfoPlistSchema.parse(JSON.parse(r.stdout));
  const platforms = info.CFBundleSupportedPlatforms ?? [];
  if (platforms.length > 0 && !platforms.includes("iPhoneSimulator")) {
    throw new BuildFormatError(`시뮬레이터용 빌드가 아니다(${platforms.join(", ")}). 시뮬레이터 대상으로 빌드한 .app 이 필요하다`);
  }
  return {
    appId: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString ?? "",
    buildNumber: info.CFBundleVersion ?? "",
  };
}

/** `aapt2 dump badging` 첫 줄: package: name='x' versionCode='9' versionName='1.2.3' ... */
export function parseAaptBadging(stdout: string): AppMetadata {
  const line = stdout.split("\n").find((l) => l.startsWith("package:"));
  const field = (key: string) => (line ? new RegExp(`${key}='([^']*)'`).exec(line)?.[1] : undefined);
  const appId = field("name");
  if (!appId) throw new BuildFormatError("APK 패키지 이름을 읽지 못했다");
  return { appId, version: field("versionName") ?? "", buildNumber: field("versionCode") ?? "" };
}

/** 가장 새 build-tools 의 aapt2 */
export function findAapt2(androidHome: string): string | null {
  const dir = join(androidHome, "build-tools");
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const aapt2 = join(dir, v, "aapt2");
    if (existsSync(aapt2)) return aapt2;
  }
  return null;
}

export async function readApkMetadata(apk: string, androidHome: string, run: CommandRunner): Promise<AppMetadata> {
  const aapt2 = findAapt2(androidHome);
  if (!aapt2) throw new BuildFormatError("Android build-tools(aapt2)를 찾지 못했다");
  const r = await run(aapt2, ["dump", "badging", apk]);
  if (r.code !== 0) throw new BuildFormatError(`APK 를 읽지 못했다: ${r.stderr.trim().slice(0, 200)}`);
  return parseAaptBadging(r.stdout);
}
