import { z } from "zod";
import { AppIdSchema } from "./builds";

/** 플로우 재생 실행 (PLAN 3.2 RunService, 5장 run·execution·step, 7장, T-107). */

export const RunStatusSchema = z.enum(["queued", "running", "passed", "failed", "error", "canceled"]);
export const ExecutionStatusSchema = z.enum(["queued", "running", "passed", "failed", "error", "skipped"]);
/** PLAN 5장. 드라이버 시작 실패·시뮬레이터 부팅 실패는 env_issue */
export const FailureClassSchema = z.enum(["app_bug", "test_drift", "env_issue", "flaky", "unknown"]);
/** packages/evidence 의 실패 종류 + 앱이 정하는 canceled(사용자 취소)·internal(앱 내부 오류) */
export const FailureKindSchema = z.enum(["step_failed", "driver_start", "flow_error", "interrupted", "no_result", "canceled", "internal"]);
export const StepStatusSchema = z.enum(["completed", "failed", "warned", "skipped", "pending", "running"]);

export const RunStepSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  command: z.string(),
  /** 평가 전 명령으로 만든 설명. 변수 값 대신 ${이름}이 보인다 */
  description: z.string(),
  status: StepStatusSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  /** 실행 증적 폴더(가린 사본) 기준 상대 경로 */
  screenshot: z.string().nullable(),
  failureScreenshot: z.string().nullable(),
  hierarchy: z.string().nullable(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const ExecutionSchema = z.strictObject({
  id: z.string(),
  attempt: z.number().int().min(1),
  status: ExecutionStatusSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  failureClass: FailureClassSchema.nullable(),
  failure: z.strictObject({ kind: FailureKindSchema, message: z.string(), stepIndex: z.number().int().nonnegative().nullable() }).nullable(),
  /** 실행 시작 때의 1분 부하 평균(PLAN 7.10) */
  hostLoad: z.number().nonnegative().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  warnings: z.array(z.string()),
  steps: z.array(RunStepSchema),
});
export type Execution = z.infer<typeof ExecutionSchema>;

export const RunSummarySchema = z.strictObject({
  id: z.string(),
  status: RunStatusSchema,
  app: AppIdSchema,
  flowName: z.string(),
  flowPath: z.string(),
  /** 플로우 이름·태그의 TC-NNNN. 없으면 "adhoc" */
  tcId: z.string(),
  target: z.enum(["ios", "android"]),
  deviceId: z.string(),
  deviceName: z.string(),
  buildId: z.string().nullable(),
  /** 예: "com.example.demo 1.0 (1)" */
  buildLabel: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  /** 실패 뒤 재시도에서 통과했다(PLAN 7.7) */
  flaky: z.boolean(),
  failureMessage: z.string().nullable(),
  /** "보관" 표시. 보관 기간이 지나도 증적을 지우지 않는다(PLAN 9.1) */
  kept: z.boolean(),
  /** 보관 기간이 지나 이 실행의 로컬 증적을 지웠다 */
  evidenceRemoved: z.boolean(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunDetailSchema = RunSummarySchema.extend({ executions: z.array(ExecutionSchema) });
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** main 의 선택 창으로 고른 플로우. 렌더러는 이 경로만 runs:start 에 다시 넘길 수 있다 */
export const PickedFlowSchema = z.strictObject({
  path: z.string(),
  name: z.string(),
  appId: z.string().nullable(),
  tcId: z.string(),
});
export type PickedFlow = z.infer<typeof PickedFlowSchema>;

export const StartRunInputSchema = z.strictObject({
  app: AppIdSchema,
  flowPath: z.string().min(1).max(4096),
  deviceId: z.string().min(1),
  /** 설치할 빌드. null 이면 기기에 이미 설치된 앱으로 실행한다 */
  buildId: z.string().min(1).nullable(),
});
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export const RunRefSchema = z.strictObject({ runId: z.string().min(1) });
export const SetKeepInputSchema = z.strictObject({ runId: z.string().min(1), keep: z.boolean() });

/** 워크스페이스의 TC·태그로 실행(PLAN 12장). 경로는 main 이 워크스페이스에서 찾는다 */
export const StartFromWorkspaceInputSchema = z.strictObject({
  app: AppIdSchema,
  target: z.enum(["ios", "android"]),
  tcId: z.string().regex(/^TC-\d{4,}$/).optional(),
  tag: z.string().min(1).max(60).optional(),
  deviceId: z.string().min(1),
  buildId: z.string().min(1).nullable(),
}).refine((v) => (v.tcId ? 1 : 0) + (v.tag ? 1 : 0) === 1, { message: "tcId 나 tag 중 하나만" });
export type StartFromWorkspaceInput = z.infer<typeof StartFromWorkspaceInputSchema>;

export const RunQueueStatusSchema = z.strictObject({ pending: z.array(z.string()), running: z.string().nullable(), errors: z.array(z.string()) });
export type RunQueueStatus = z.infer<typeof RunQueueStatusSchema>;
