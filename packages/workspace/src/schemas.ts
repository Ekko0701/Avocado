import { AppIdSchema, LocaleSchema } from "@qa/shared";
import { z } from "zod";

/** 워크스페이스 저장소 파일 스키마 (PLAN 4.1~4.3). 저장소 파일은 외부 입력이라 모두 검증한다(CLAUDE.md 4장). */

/** TC 하나에서 만드는 플로우 타깃 (PLAN 1.2) */
export const TargetSchema = z.enum(["ios", "android", "flutter-ios", "flutter-android"]);
export type Target = z.infer<typeof TargetSchema>;

export const TC_ID = /^TC-\d{4,}$/;
export const TcIdSchema = z.string().regex(TC_ID, "TC id 는 TC-0001 형식");

export const WorkspaceConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  apps: z.array(AppIdSchema).min(1),
  defaults: z.strictObject({ locale: LocaleSchema.optional() }).optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const AppConfigSchema = z.strictObject({
  name: z.string().min(1),
  /** 기기 언어. 텍스트 선택자는 이 언어 기준이다(부록 B) */
  locale: LocaleSchema.optional(),
  targets: z
    .partialRecord(
      TargetSchema,
      z.strictObject({
        /** iOS 번들 ID 또는 Android 패키지(플로우의 ${APP_ID}) */
        appId: z.string().min(1),
        build: z
          .strictObject({
            script: z.string().min(1).optional(),
            note: z.string().optional(),
            /** 프로젝트 폴더로 빌드할 때 팀이 같이 쓰는 스킴·구성(ADR 0025) */
            scheme: z.string().min(1).optional(),
            configuration: z.string().min(1).optional(),
          })
          .optional(),
      }),
    )
    .refine((t) => Object.keys(t).length > 0, "타깃이 하나 이상 있어야 한다"),
  /** 실행 전 조건(로컬 서버 등) 안내 */
  note: z.string().optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * accounts.yaml: 계정 역할 → 설명과 키 이름 목록. 값은 두지 않는다(값은 각자 키체인의 account:<앱>:<키>).
 * TC 의 account 는 역할 이름이고, 플로우는 그 역할의 키(${KEY})를 쓴다(PLAN 4.2 린트: account 는 accounts.yaml 에 있어야 한다).
 */
export const AccountKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "키 이름은 대문자·숫자·밑줄");
export const AccountRoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "역할 이름은 소문자·숫자·하이픈");
export const AccountsSchema = z
  .record(z.string(), z.strictObject({ description: z.string(), keys: z.array(AccountKeySchema).min(1) }))
  .superRefine((accounts, ctx) => {
    for (const role of Object.keys(accounts)) {
      if (!AccountRoleSchema.safeParse(role).success) ctx.addIssue({ code: "custom", path: [role], message: "역할 이름은 소문자·숫자·하이픈" });
    }
  });
export type Accounts = z.infer<typeof AccountsSchema>;

export const TestcaseFrontMatterSchema = z.strictObject({
  id: TcIdSchema,
  title: z.string().min(1).max(120),
  app: AppIdSchema,
  targets: z.array(TargetSchema).min(1),
  priority: z.enum(["high", "medium", "low"]).optional(),
  tags: z.array(z.string().min(1)).optional(),
  /** 계정 역할 이름(예: student). accounts.yaml 에 있는지는 린트가 본다 */
  account: z.string().min(1).optional(),
  status: z.enum(["active", "draft", "deprecated"]),
});
export type TestcaseFrontMatter = z.infer<typeof TestcaseFrontMatterSchema>;

export const FlowMetaSchema = z.strictObject({
  tc: TcIdSchema,
  tcVersion: z.string().min(1),
  target: TargetSchema,
  generatedBy: z.enum(["agent", "human"]),
  agentModel: z.string().optional(),
  goldenRun: z
    .strictObject({
      appBuild: z.string(),
      device: z.string(),
      result: z.enum(["passed", "failed"]),
      evidenceLink: z.string().nullable(),
    })
    .optional(),
  missingIdentifiers: z.array(z.strictObject({ screen: z.string(), element: z.string(), fallback: z.string() })).optional(),
});
export type FlowMeta = z.infer<typeof FlowMetaSchema>;
