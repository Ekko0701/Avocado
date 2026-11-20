import type { RunBatch, RunStartErrorCode } from "@qa/shared";

/** 종료 코드(ADR 0035). 여러 개에 해당하면 위의 것(connect → args → error → canceled → failed → noFlow)이 이긴다 */
export const EXIT = { ok: 0, failed: 1, args: 2, connect: 3, canceled: 4, noFlow: 5, error: 6 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 시작 거절 코드 → 종료 코드. 사람이 인자를 고치면 되는 것은 2, 플로우가 없으면 5, 앱·기기 상태 때문이면 6 */
export const START_ERROR_EXIT: Record<RunStartErrorCode, ExitCode> = {
  unknown_app: EXIT.args,
  unknown_testcase: EXIT.args,
  bad_build: EXIT.args,
  device_ambiguous: EXIT.args,
  no_flow: EXIT.noFlow,
  device_not_ready: EXIT.error,
  queue_busy: EXIT.error,
  workspace_not_connected: EXIT.error,
  caller_busy: EXIT.error,
};

/** 끝난 묶음의 종료 코드 */
export function batchExit(batch: Pick<RunBatch, "items" | "skipped">): ExitCode {
  const statuses = batch.items.map((i) => i.status);
  if (statuses.includes("error")) return EXIT.error;
  if (statuses.includes("canceled")) return EXIT.canceled;
  if (statuses.includes("failed")) return EXIT.failed;
  if (batch.skipped.length > 0) return EXIT.noFlow;
  return EXIT.ok;
}
