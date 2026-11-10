import { z } from "zod";

/**
 * QA 수정 작업 모니터링(사이드 브랜치 side/qa-fix-monitor).
 * 이슈 트래커의 QA 티켓 하나를 Claude Code 가 분석·수정·기기 확인·MR 까지 진행하는 동안, 그 진행을 Avocado 가 받아 적고 보여 준다.
 * Avocado 는 작업을 지휘하지 않는다. 보고를 기록하고, 요청받은 플로우를 기기에서 재생해 증적을 남길 뿐이다.
 */
export const QaJobStageSchema = z.enum(["received", "analysis", "fix", "build", "verify", "mr", "done"]);
export type QaJobStage = z.infer<typeof QaJobStageSchema>;

/** running: 진행 중 · succeeded: MR 까지 끝남 · failed: 오류로 멈춤 · stopped: 원인을 못 찾았거나 재현이 안 돼 사람에게 넘김 */
export const QaJobStatusSchema = z.enum(["running", "succeeded", "failed", "stopped"]);
export type QaJobStatus = z.infer<typeof QaJobStatusSchema>;

/**
 * 기기 확인이 어디까지 됐는지. "했다"와 "확인됐다"를 구분한다.
 * not_run: 기기에서 돌리지 않음 · unverified: 돌렸지만 확인할 근거가 부족함 ·
 * verified: 수정 후 실행이 통과하고 화면을 확인함 · verified_after_retry: 첫 시도는 실패했고 다시 돌려 통과함
 */
export const QaVerificationSchema = z.enum(["not_run", "unverified", "verified", "verified_after_retry"]);
export type QaVerification = z.infer<typeof QaVerificationSchema>;

/** 단계를 마쳤다는 근거로 남기는 글. spec: 확정한 기대값 · analysis: 원인과 수정 방향 · verdict: 기대값과 실제를 대조한 판정 */
export const QaArtifactKindSchema = z.enum(["spec", "analysis", "verdict"]);
export type QaArtifactKind = z.infer<typeof QaArtifactKindSchema>;
export const QaArtifactSchema = z.strictObject({
  kind: QaArtifactKindSchema,
  content: z.string(),
  at: z.iso.datetime(),
});
export type QaArtifact = z.infer<typeof QaArtifactSchema>;

export const QaJobEventSchema = z.strictObject({
  at: z.iso.datetime(),
  stage: QaJobStageSchema,
  message: z.string(),
});
export type QaJobEvent = z.infer<typeof QaJobEventSchema>;

/** 이 작업이 기기에서 돌린 실행. before: 수정 전 재현 · after: 수정 후 확인 · check: 그 밖의 확인 */
export const QaJobRunLabelSchema = z.enum(["before", "after", "check"]);
export const QaJobRunSchema = z.strictObject({
  runId: z.string(),
  label: QaJobRunLabelSchema,
  deviceName: z.string(),
  /** 실행이 끝났을 때의 상태. 끝나기 전이면 null */
  status: z.enum(["passed", "failed", "error", "canceled"]).nullable(),
  /** 첫 시도는 실패했고 다시 돌려 통과했다 */
  flaky: z.boolean().default(false),
  /** 이 실행 동안의 앱 로그(가린 사본) 파일. 모으지 못했으면 null */
  logPath: z.string().nullable().default(null),
  at: z.iso.datetime(),
});
export type QaJobRun = z.infer<typeof QaJobRunSchema>;

export const QaJobSchema = z.strictObject({
  id: z.string(),
  /** 이슈 트래커의 티켓 표기(예: "앱-QA/567") */
  ticket: z.string(),
  title: z.string(),
  /** 티켓 주소. 화면에는 글자로만 보인다(앱은 허용 목록 밖의 주소를 열지 않는다) */
  url: z.string().nullable(),
  stage: QaJobStageSchema,
  status: QaJobStatusSchema,
  branch: z.string().nullable(),
  mrUrl: z.string().nullable(),
  verification: QaVerificationSchema.default("not_run"),
  /** 기기 확인을 못 했거나 근거가 부족한 이유 */
  verificationNote: z.string().nullable().default(null),
  artifacts: z.array(QaArtifactSchema).default([]),
  events: z.array(QaJobEventSchema),
  runs: z.array(QaJobRunSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type QaJob = z.infer<typeof QaJobSchema>;
