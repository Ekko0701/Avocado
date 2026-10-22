import { z } from "zod";

/** 파서 결과. 경로는 모두 실행 폴더 기준 상대 경로(구분자 /)다. */

export const StepStatusSchema = z.enum(["completed", "failed", "warned", "skipped", "pending", "running"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ArtifactKindSchema = z.enum([
  "console_log",
  "junit",
  "command_metadata",
  "manifest",
  "maestro_log",
  "device_log",
  "runner_log",
  "take_screenshot",
  "failure_screenshot",
  "screen_hierarchy",
  "other",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z.strictObject({
  kind: ArtifactKindSchema,
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  /** 이 산출물을 만든 스텝(Step.index). 스텝과 무관하면 null */
  stepIndex: z.number().int().nonnegative().nullable(),
  image: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const StepSchema = z.strictObject({
  /** 보고용 순번(0부터). 변수 정의·설정 적용 같은 내부 명령은 빠진다 */
  index: z.number().int().nonnegative(),
  /** Maestro sequenceNumber. 실패 산출물 파일 이름의 step-NNN 은 이 값 + 1 이다 */
  sequenceNumber: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
  command: z.string(),
  /** 평가 전 명령으로 만든 설명. 변수 값이 아니라 ${이름}이 보인다 */
  description: z.string(),
  status: StepStatusSchema,
  startedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.strictObject({ message: z.string(), debugMessage: z.string().nullable() }).nullable(),
  screenshot: z.string().nullable(),
  failureScreenshot: z.string().nullable(),
  hierarchy: z.string().nullable(),
});
export type Step = z.infer<typeof StepSchema>;

export const FailureKindSchema = z.enum([
  /** 스텝이 실패했다 */
  "step_failed",
  /** Maestro 드라이버가 뜨지 못해 플로우를 시작하지 못했다 */
  "driver_start",
  /** 플로우 결과는 실패인데 실패한 스텝이 없다(플로우 파일 오류 등) */
  "flow_error",
  /** 실행 중에 끊겼다(실행 중·대기 상태 스텝이 남음) */
  "interrupted",
  /** 결과를 판단할 산출물이 없다 */
  "no_result",
]);

export const FailureSchema = z.strictObject({
  kind: FailureKindSchema,
  message: z.string(),
  stepIndex: z.number().int().nonnegative().nullable(),
});
export type Failure = z.infer<typeof FailureSchema>;

export const ExecutionStatusSchema = z.enum(["passed", "failed", "error"]);

export const ParsedExecutionSchema = z.strictObject({
  /** passed·failed 는 플로우가 돌았다. error 는 플로우를 시작하지 못했거나 결과를 알 수 없다 */
  status: ExecutionStatusSchema,
  /** 산출물만으로 확정할 수 있는 실패 분류. 지금은 드라이버 실패의 env_issue 만. 나머지는 heal(M2)이 정한다 */
  failureClass: z.enum(["env_issue"]).nullable(),
  flowName: z.string().nullable(),
  appId: z.string().nullable(),
  platform: z.enum(["ios", "android"]).nullable(),
  /** JUnit 의 기기 문자열. 예: "QA Tool iPhone 17 - iOS 27.0 - <UDID>" */
  device: z.string().nullable(),
  sessionDir: z.string().nullable(),
  flowDir: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  steps: z.array(StepSchema),
  failure: FailureSchema.nullable(),
  artifacts: z.array(ArtifactSchema),
  /** 결과는 냈지만 사람이 알아야 할 불일치(예: 매니페스트에 있는데 없는 파일) */
  warnings: z.array(z.string()),
});
export type ParsedExecution = z.infer<typeof ParsedExecutionSchema>;

export class EvidenceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceParseError";
  }
}
