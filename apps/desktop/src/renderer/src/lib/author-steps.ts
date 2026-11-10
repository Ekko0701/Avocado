import type { AuthorJob } from "@qa/shared";

/** mine: 사용자가 할 일(Claude 에 요청 붙여 넣기)이 있는 단계 */
export type StepState = "done" | "active" | "mine" | "failed" | "pending";
type Phase = Exclude<AuthorJob["phase"], "done">;

export interface AuthorStep {
  phase: Phase;
  label: string;
  state: StepState;
  /** 단계 이름 아래 한 줄: 하는 일(시작 전), 진행(스텝 3/7), 결과(2번 통과·오류 2개) */
  sub: string;
}

const ORDER: { phase: Phase; label: string; idle: string }[] = [
  { phase: "preparing", label: "준비", idle: "기기·앱 준비" },
  { phase: "waiting_claude", label: "Claude 에 요청", idle: "요청 붙여 넣기" },
  { phase: "exploring", label: "기기 탐색", idle: "테스트 케이스 따라가기" },
  { phase: "checking", label: "규약 검사", idle: "플로우 규약" },
  { phase: "replaying", label: "두 번 재생", idle: "같은 기기에서" },
  { phase: "saving", label: "저장", idle: "작업 브랜치 커밋" },
];

const isRunning = (job: AuthorJob) => job.job.status === "queued" || job.job.status === "running";
const failedReplayIndex = (job: AuthorJob) => job.replays.findIndex((r) => r.status !== "passed");

/**
 * 통과하지 못하고 끝난 작업이 멈춘 단계. 앱이 남긴 값(stoppedAt)이 없으면(예전 기록) 남은 결과로 짐작한다:
 * 통과하지 못한 재생이 있으면 재생, 규약 오류가 있으면 규약 검사. 알 수 없으면 null
 */
export function stoppedPhase(job: AuthorJob): Phase | null {
  if (isRunning(job) || job.job.status === "succeeded") return null;
  if (job.stoppedAt) return job.stoppedAt;
  if (failedReplayIndex(job) >= 0) return "replaying";
  if (job.lint.some((l) => l.level === "error")) return "checking";
  return null;
}

/** 단계 표시줄. API 키 방식에는 "Claude 에 요청" 단계가 없다. job 이 없으면(시작 전) 모두 대기 */
export function authorSteps(job: AuthorJob | null, driver: AuthorJob["driver"]): AuthorStep[] {
  const order = ORDER.filter((s) => driver === "claude-app" || s.phase !== "waiting_claude");
  if (!job) return order.map((s) => ({ phase: s.phase, label: s.label, state: "pending", sub: s.idle }));

  const running = isRunning(job);
  const succeeded = job.job.status === "succeeded";
  const stopped = stoppedPhase(job);
  // 지금(또는 멈춘) 단계의 자리. 성공했으면 끝까지, 멈춘 곳을 모르면 아무 단계도 끝난 것으로 치지 않는다
  const at = succeeded ? order.length : order.findIndex((s) => s.phase === (running ? job.phase : stopped));

  return order.map((s, i) => {
    const base = { phase: s.phase, label: s.label };
    if (at < 0) return { ...base, state: "pending", sub: s.idle };
    if (i < at) return { ...base, state: "done", sub: doneSub(s.phase, job) };
    if (i > at) return { ...base, state: "pending", sub: running ? s.idle : "하지 않음" };
    if (running) return { ...base, state: s.phase === "waiting_claude" ? "mine" : "active", sub: activeSub(s.phase, job) };
    return { ...base, state: "failed", sub: failedSub(s.phase, job) };
  });
}

function doneSub(phase: Phase, job: AuthorJob): string {
  if (phase === "exploring" && job.totalSteps > 0) return `스텝 ${job.totalSteps}/${job.totalSteps}`;
  if (phase === "checking") {
    const warnings = job.lint.filter((l) => l.level === "warning").length;
    return warnings > 0 ? `경고 ${warnings}개` : "오류 없음";
  }
  if (phase === "replaying") return "2번 통과";
  if (phase === "saving" && job.result) return job.result.unchanged ? "이미 있음" : job.result.commit.slice(0, 7);
  return "끝";
}

function activeSub(phase: Phase, job: AuthorJob): string {
  if (phase === "waiting_claude") return "내 차례";
  if (phase === "exploring") return job.totalSteps > 0 ? `스텝 ${job.step}/${job.totalSteps}` : "탐색 중";
  if (phase === "replaying") return `${Math.min(job.replays.length + 1, 2)}번째 재생`;
  return "진행 중";
}

function failedSub(phase: Phase, job: AuthorJob): string {
  if (job.job.status === "canceled") return "취소";
  if (job.job.status === "budget_exceeded") return "예산 초과";
  if (phase === "replaying" && failedReplayIndex(job) >= 0) return `${failedReplayIndex(job) + 1}번 실패`;
  if (phase === "checking") {
    const errors = job.lint.filter((l) => l.level === "error").length;
    if (errors > 0) return `오류 ${errors}개`;
  }
  return "실패";
}

const STOPPED_TITLE: Record<Phase, string> = {
  preparing: "기기와 앱을 준비하다 멈췄습니다",
  waiting_claude: "Claude 가 작업을 맡기 전에 멈췄습니다",
  exploring: "기기 탐색에서 멈췄습니다",
  checking: "플로우 규약 검사를 통과하지 못했습니다",
  replaying: "재생에서 실패해 저장하지 않았습니다",
  saving: "작업 브랜치에 저장하지 못했습니다",
};

/** 통과하지 못하고 끝난 작업의 한 줄 제목 */
export function stoppedTitle(job: AuthorJob): string {
  const stopped = stoppedPhase(job);
  const where = stopped ? ORDER.find((s) => s.phase === stopped)?.label : null;
  if (job.job.status === "canceled") return where ? `${where} 단계에서 취소했습니다` : "취소했습니다";
  if (job.job.status === "budget_exceeded") return "작업 상한에 닿아 멈췄습니다";
  return stopped ? STOPPED_TITLE[stopped] : "플로우를 만들지 못했습니다";
}

/** 통과하지 못한 첫 재생의 실행 ID(결과 화면에서 캡처·로그를 본다) */
export function failedReplayRun(job: AuthorJob): string | null {
  const i = failedReplayIndex(job);
  return i >= 0 ? (job.replays[i]?.runId ?? null) : null;
}
