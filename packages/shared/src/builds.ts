import { z } from "zod";

/** 테스트 대상 앱 빌드 (PLAN 3.2 BuildService, 5장 build 테이블, T-105). */
export const AppIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "앱 id 는 소문자·숫자·하이픈");

export const BuildSchema = z.strictObject({
  id: z.string(),
  app: AppIdSchema,
  target: z.enum(["ios", "android"]),
  /** iOS 번들 ID 또는 Android 패키지 이름 (Maestro appId) */
  appId: z.string(),
  version: z.string(),
  buildNumber: z.string(),
  commit: z.string().nullable(),
  /** file: 파일로 등록, script: 빌드 스크립트, project: 연결한 프로젝트 폴더를 앱이 빌드(ADR 0025) */
  source: z.enum(["file", "script", "project"]),
  /** 앱 데이터 폴더 안에 복사된 .app 또는 .apk */
  path: z.string(),
  createdAt: z.iso.datetime(),
  /** 프로젝트 빌드의 "스킴 · 구성" 같은 이름표 */
  label: z.string().nullable(),
});
export type Build = z.infer<typeof BuildSchema>;

// 경로는 렌더러가 넘기지 않는다(CLAUDE.md 5장). main 의 선택 창으로만 고른다.
export const PickBuildInputSchema = z.strictObject({ app: AppIdSchema });
export const RunBuildScriptInputSchema = z.strictObject({ app: AppIdSchema });
export const InstallBuildInputSchema = z.strictObject({ buildId: z.string().min(1), deviceId: z.string().min(1) });
export const InstallResultSchema = z.strictObject({ buildId: z.string(), deviceId: z.string(), appId: z.string(), installed: z.boolean() });
export type InstallResult = z.infer<typeof InstallResultSchema>;

/** 스킴·구성 이름(xcodebuild 에 인자로 그대로 넘긴다). 줄바꿈·제어 문자는 받지 않는다 */
export const XcodeNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 0x20), "스킴·구성 이름 형식이 아니다");
/** 빌드 전에 앱이 돌리는 준비 도구(ADR 0025) */
export const ProjectToolSchema = z.enum(["tuist", "xcodegen", "cocoapods"]);
export type ProjectTool = z.infer<typeof ProjectToolSchema>;

/** 이 Mac 에 연결한 iOS 프로젝트와 고를 수 있는 스킴·구성 */
export const IosProjectSchema = z.strictObject({
  /** 고른 폴더 또는 .xcworkspace·.xcodeproj */
  path: z.string(),
  /** 빌드에 쓰는 .xcworkspace·.xcodeproj. Tuist·XcodeGen 프로젝트를 아직 생성하지 않았으면 null */
  container: z.string().nullable(),
  tools: z.array(ProjectToolSchema),
  schemes: z.array(z.string()),
  configurations: z.array(z.string()),
  /** HEAD 커밋과 커밋하지 않은 변경 수. git 저장소가 아니면 null */
  git: z.strictObject({ commit: z.string(), changes: z.number().int().nonnegative() }).nullable(),
  /** 이 Mac 에서 마지막으로 고른 값 */
  scheme: z.string().nullable(),
  configuration: z.string().nullable(),
  /** 팀 기본값(app.yaml 의 targets.ios.build) */
  teamScheme: z.string().nullable(),
  teamConfiguration: z.string().nullable(),
  /** 스킴을 읽지 못한 이유. 없으면 null */
  problem: z.string().nullable(),
});
export type IosProject = z.infer<typeof IosProjectSchema>;
export const ProjectStatusSchema = z.strictObject({ app: AppIdSchema, ios: IosProjectSchema.nullable() });
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
/** prepare: 생성 전인 Tuist·XcodeGen 프로젝트를 만들고(필요하면 pod install) 스킴을 다시 읽는다 */
export const ProjectStatusInputSchema = z.strictObject({ app: AppIdSchema, prepare: z.boolean().optional() });
export const ProjectRefSchema = z.strictObject({ app: AppIdSchema });
export const BuildProjectInputSchema = z.strictObject({ app: AppIdSchema, scheme: XcodeNameSchema, configuration: XcodeNameSchema });

/** 빌드 작업 종류: 빌드 스크립트, 프로젝트 빌드, 프로젝트 준비(Tuist·XcodeGen 생성, pod install) */
export const BuildJobKindSchema = z.enum(["script", "project", "prepare"]);
export type BuildJobKind = z.infer<typeof BuildJobKindSchema>;
/**
 * 지금 진행 중인 빌드와 마지막으로 끝난 빌드(한 번에 하나, main 이 들고 있다).
 * 화면을 떠났다 돌아와도 진행 단계·로그·결과를 다시 보여 준다. 로그는 마지막 몇십 줄만 준다
 */
export const BuildActivitySchema = z.strictObject({
  running: z
    .strictObject({
      app: z.string(),
      kind: BuildJobKindSchema,
      /** "스킴 · 구성" 또는 스크립트 이름 */
      label: z.string(),
      /** 지금 단계(tuist install, xcodebuild …) */
      step: z.string().nullable(),
      startedAt: z.iso.datetime(),
      log: z.string(),
    })
    .nullable(),
  last: z
    .strictObject({
      app: z.string(),
      kind: BuildJobKindSchema,
      label: z.string(),
      startedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime(),
      ok: z.boolean(),
      canceled: z.boolean(),
      error: z.string().nullable(),
      /** 등록한 빌드(성공한 빌드 작업) */
      build: BuildSchema.nullable(),
      log: z.string(),
    })
    .nullable(),
});
export type BuildActivity = z.infer<typeof BuildActivitySchema>;
