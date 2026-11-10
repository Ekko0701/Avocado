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
  events: z.array(QaJobEventSchema),
  runs: z.array(QaJobRunSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type QaJob = z.infer<typeof QaJobSchema>;
