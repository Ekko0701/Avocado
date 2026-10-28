import type { ProjectTool } from "@qa/shared";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";

/** Xcode 프로젝트 폴더 해석 (ADR 0025). 파일만 읽는다(명령은 실행하지 않는다) */

export interface XcodeContainer {
  kind: "workspace" | "project";
  path: string;
}

export interface XcodeLayout {
  /** 프로젝트 루트(고른 것이 .xcworkspace·.xcodeproj 면 그 폴더) */
  root: string;
  /** 빌드에 쓸 .xcworkspace·.xcodeproj. 생성 전이면 null */
  container: XcodeContainer | null;
  /** 빌드 전에 돌릴 준비 도구 */
  tools: ProjectTool[];
}

const CONTAINER_EXT = { ".xcworkspace": "workspace", ".xcodeproj": "project" } as const;
const TUIST_FILES = ["Project.swift", "Workspace.swift", "Tuist.swift", join("Tuist", "Config.swift")];
const XCODEGEN_FILES = ["project.yml", "project.json"];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 루트 바로 아래의 .xcworkspace(우선) 또는 .xcodeproj. 여러 개면 폴더 이름과 같은 것, 아니면 이름순 첫 번째 */
export function findContainer(root: string): XcodeContainer | null {
  const entries = readdirSync(root).filter((name) => isDir(join(root, name)));
  for (const ext of [".xcworkspace", ".xcodeproj"] as const) {
    // Pods.xcodeproj 는 Pods 폴더 안에 있어 여기 나오지 않는다. 혹시 루트에 있어도 앱 프로젝트가 아니다
    const found = entries.filter((name) => extname(name) === ext && name !== "Pods.xcodeproj").sort();
    if (found.length === 0) continue;
    const preferred = found.find((name) => basename(name, ext) === basename(root)) ?? found[0];
    if (preferred) return { kind: CONTAINER_EXT[ext], path: join(root, preferred) };
  }
  return null;
}

/** 고른 경로(폴더 또는 .xcworkspace·.xcodeproj)에서 루트·컨테이너·준비 도구를 찾는다 */
export function xcodeLayout(selected: string): XcodeLayout {
  const ext = extname(selected);
  const picked = ext === ".xcworkspace" || ext === ".xcodeproj";
  const root = picked ? dirname(selected) : selected;
  const tools: ProjectTool[] = [];
  if (TUIST_FILES.some((f) => existsSync(join(root, f)))) tools.push("tuist");
  if (XCODEGEN_FILES.some((f) => existsSync(join(root, f)))) tools.push("xcodegen");
  if (existsSync(join(root, "Podfile"))) tools.push("cocoapods");
  const container = picked ? { kind: CONTAINER_EXT[ext], path: selected } : findContainer(root);
  return { root, container, tools };
}

/** Xcode 프로젝트로 볼 수 있는가: 컨테이너가 있거나 생성 도구 파일이 있다 */
export function looksLikeXcodeProject(layout: XcodeLayout): boolean {
  return layout.container !== null || layout.tools.includes("tuist") || layout.tools.includes("xcodegen");
}

/** pod install 이 필요한가: Podfile 은 있는데 Pods/Manifest.lock 이 없거나 Podfile.lock 과 다르다(CocoaPods 의 확인 방식) */
export function podsOutdated(root: string): boolean {
  if (!existsSync(join(root, "Podfile"))) return false;
  const manifest = join(root, "Pods", "Manifest.lock");
  const lock = join(root, "Podfile.lock");
  if (!existsSync(manifest) || !existsSync(lock)) return true;
  return readFileSync(manifest, "utf8") !== readFileSync(lock, "utf8");
}

const ListSchema = z.looseObject({
  workspace: z.looseObject({ schemes: z.array(z.string()).optional() }).optional(),
  project: z.looseObject({ schemes: z.array(z.string()).optional(), configurations: z.array(z.string()).optional() }).optional(),
});

/** `xcodebuild -list -json` 출력. 앞에 경고 줄이 붙어 나올 수 있어 첫 { 부터 읽는다 */
export function parseXcodebuildList(output: string): { schemes: string[]; configurations: string[] } {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("xcodebuild -list 출력에 JSON 이 없다");
  const parsed = ListSchema.parse(JSON.parse(output.slice(start)));
  const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
  return { schemes, configurations: parsed.project?.configurations ?? [] };
}

/** 빌드 결과 폴더 바로 아래의 .app 들 */
export function builtApps(productsDir: string): string[] {
  if (!isDir(productsDir)) return [];
  return readdirSync(productsDir)
    .filter((name) => name.endsWith(".app") && isDir(join(productsDir, name)))
    .sort()
    .map((name) => join(productsDir, name));
}

/** git status --porcelain 의 변경 줄 수 */
export function countChanges(porcelain: string): number {
  return porcelain.split("\n").filter((line) => line.trim().length > 0).length;
}
