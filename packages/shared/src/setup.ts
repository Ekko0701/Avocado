import { z } from "zod";

/** 설정 마법사·환경 점검·도구 설치 (PLAN 11장, T-103). */

export const CheckStatusSchema = z.enum(["ok", "warn", "fail"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const SetupCheckSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: CheckStatusSchema,
  /** 필수 항목이 모두 ok 여야 마법사를 끝낼 수 있다. 선택 항목은 warn 이어도 된다. */
  required: z.boolean(),
  detail: z.string(),
  /** 사람이 할 일. 앱이 설치할 수 있는 도구는 fix 대신 tool 로 표시한다. */
  fix: z.string().nullable(),
  tool: z.enum(["jre", "maestro"]).nullable(),
});
export type SetupCheck = z.infer<typeof SetupCheckSchema>;

export const ToolIdSchema = z.enum(["jre", "maestro"]);
export type ToolId = z.infer<typeof ToolIdSchema>;

export const ToolStatusSchema = z.strictObject({
  id: ToolIdSchema,
  version: z.string(),
  installed: z.boolean(),
  path: z.string().nullable(),
  downloadBytes: z.number().int().nonnegative(),
});
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const SetupReportSchema = z.strictObject({
  checks: z.array(SetupCheckSchema),
  tools: z.array(ToolStatusSchema),
  ready: z.boolean(),
  checkedAt: z.iso.datetime(),
});
export type SetupReport = z.infer<typeof SetupReportSchema>;

export const InstallPhaseSchema = z.enum(["idle", "downloading", "verifying", "extracting", "done", "error"]);
export const InstallProgressSchema = z.strictObject({
  tool: ToolIdSchema.nullable(),
  phase: InstallPhaseSchema,
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
});
export type InstallProgress = z.infer<typeof InstallProgressSchema>;

export const MaestroVerifySchema = z.strictObject({
  ok: z.boolean(),
  version: z.string().nullable(),
  detail: z.string(),
});
export type MaestroVerify = z.infer<typeof MaestroVerifySchema>;

export const InstallToolInputSchema = z.strictObject({ tool: ToolIdSchema });
