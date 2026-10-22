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
  source: z.enum(["file", "script"]),
  /** 앱 데이터 폴더 안에 복사된 .app 또는 .apk */
  path: z.string(),
  createdAt: z.iso.datetime(),
});
export type Build = z.infer<typeof BuildSchema>;

// 경로는 렌더러가 넘기지 않는다(CLAUDE.md 5장). main 의 선택 창으로만 고른다.
export const PickBuildInputSchema = z.strictObject({ app: AppIdSchema });
export const RunBuildScriptInputSchema = z.strictObject({ app: AppIdSchema });
export const InstallBuildInputSchema = z.strictObject({ buildId: z.string().min(1), deviceId: z.string().min(1) });
export const InstallResultSchema = z.strictObject({ buildId: z.string(), deviceId: z.string(), appId: z.string(), installed: z.boolean() });
export type InstallResult = z.infer<typeof InstallResultSchema>;
