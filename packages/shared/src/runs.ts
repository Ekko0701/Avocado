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

const TcIdSchema = z.string().regex(/^TC-\d{4,}$/);
const TargetSchema = z.enum(["ios", "android"]);

/**
 * 실행 묶음(ADR 0035 결정 3). 실행 큐는 앱 전체에 하나이고 묶음도 한 번에 하나다.
 * 조회·취소는 id 로만 해서 밖(CLI)에서 붙은 클라이언트가 남의 묶음을 읽거나 끄지 못하게 한다.
 * origin 은 "app"(실행 화면) 또는 MCP 클라이언트 이름이다
 */
export const RunBatchItemSchema = z.strictObject({
  tcId: TcIdSchema,
  runId: z.string().nullable(),
  status: z.union([z.enum(["pending"]), RunStatusSchema]),
  failureMessage: z.string().nullable(),
});
export type RunBatchItem = z.infer<typeof RunBatchItemSchema>;
export const RunBatchSchema = z.strictObject({
  id: z.string(),
  origin: z.string().min(1),
  app: AppIdSchema,
  target: TargetSchema,
  deviceId: z.string(),
  buildId: z.string().nullable(),
  items: z.array(RunBatchItemSchema),
  /** 골랐지만 이 타깃의 플로우가 없어 돌리지 않은 TC. 조용히 빼지 않는다 */
  skipped: z.array(z.strictObject({ tcId: TcIdSchema, reason: z.enum(["no_flow"]) })),
  state: z.enum(["running", "done"]),
  errors: z.array(z.string()),
});
export type RunBatch = z.infer<typeof RunBatchSchema>;

/** 실행 묶음을 시작하지 않은 이유. CLI 는 code 로 종료 코드를 정하고 message 를 그대로 보인다 */
export const RunStartErrorCodeSchema = z.enum([
  "unknown_app",
  "unknown_testcase",
  "no_flow",
  "bad_build",
  "device_ambiguous",
  "device_not_ready",
  "queue_busy",
  "workspace_not_connected",
  "caller_busy",
]);
export type RunStartErrorCode = z.infer<typeof RunStartErrorCodeSchema>;
export const RunStartErrorSchema = z.strictObject({ code: RunStartErrorCodeSchema, message: z.string(), candidates: z.array(z.string()).optional() });
export type RunStartError = z.infer<typeof RunStartErrorSchema>;

/** MCP start_runs 의 입력. 기기·타깃을 빼면 main 이 준비된 기기가 하나일 때만 고른다(ADR 0035 결정 5) */
export const StartRunsInputSchema = z
  .strictObject({
    app: AppIdSchema,
    target: TargetSchema.optional(),
    tcIds: z.array(TcIdSchema).min(1).max(200).optional(),
    tag: z.string().min(1).max(60).optional(),
    deviceId: z.string().min(1).optional(),
    buildId: z.string().min(1).optional(),
  })
  .refine((v) => (v.tcIds ? 1 : 0) + (v.tag ? 1 : 0) === 1, { message: "tcIds 나 tag 중 하나만" });
export type StartRunsInput = z.infer<typeof StartRunsInputSchema>;
export const StartRunsResultSchema = z.union([z.strictObject({ batch: RunBatchSchema }), z.strictObject({ error: RunStartErrorSchema })]);
export type StartRunsResult = z.infer<typeof StartRunsResultSchema>;
export const RunsStatusInputSchema = z.strictObject({ batchId: z.string().min(1), waitSeconds: z.number().int().min(0).max(45).optional() });
export const CancelRunsInputSchema = z.strictObject({ batchId: z.string().min(1) });

/** run_options: 밖에서 실행을 고를 때 쓰는 목록 */
export const RunOptionsSchema = z.strictObject({
  appVersion: z.string(),
  workspaceConnected: z.boolean(),
  apps: z.array(z.strictObject({ app: AppIdSchema, testcases: z.array(z.strictObject({ id: TcIdSchema, title: z.string(), tags: z.array(z.string()), status: z.string(), flows: z.array(TargetSchema) })) })),
  devices: z.array(z.strictObject({ id: z.string(), name: z.string(), platform: TargetSchema, kind: z.enum(["simulator", "emulator", "real"]) })),
  builds: z.array(z.strictObject({ id: z.string(), app: AppIdSchema, target: TargetSchema, label: z.string(), createdAt: z.string() })),
  busy: z.string().nullable(),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

/** avocado CLI 가 MCP 소켓에 붙을 때 쓰는 클라이언트 이름. 설정·툴바의 "연결된 Claude" 수에서 뺀다 */
export const AVOCADO_CLI_CLIENT_NAME = "avocado-cli";

/** 화면이 보는 차례 실행 상태. 지금 묶음(없으면 마지막 묶음)에서 계산한다 */
export const RunQueueStatusSchema = z.strictObject({
  pending: z.array(z.string()),
  running: z.string().nullable(),
  errors: z.array(z.string()),
  batchId: z.string().nullable(),
  origin: z.string().nullable(),
});
export type RunQueueStatus = z.infer<typeof RunQueueStatusSchema>;
