import type { AuthorJob, RunDetail, RunSummary, TestcaseList } from "@qa/shared";

/** 끝난 실행. 취소는 결과가 아니라서 지표에 넣지 않는다 */
const FINISHED = new Set<RunSummary["status"]>(["passed", "failed", "error"]);
const DAY = 24 * 60 * 60 * 1000;
export const isActiveRun = (r: RunSummary) => r.status === "queued" || r.status === "running";
const isFail = (s: RunSummary["status"]) => s === "failed" || s === "error";

/** 이 Mac 의 날짜(YYYY-MM-DD). 차트의 날 구분은 현지 시각을 따른다 */
export function localDay(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** 최근 days 일 동안 재시도에서 통과한(불안정) 실행 수 */
export function flakyCount(runs: readonly RunSummary[], now: Date, days = 7): number {
  const since = now.getTime() - days * DAY;
  return runs.filter((r) => r.flaky && Date.parse(r.createdAt) >= since).length;
}

export interface DayCount {
  day: string;
  passed: number;
  /** 실패와 오류 */
  failed: number;
}

/** 오늘까지 days 일의 날마다 통과·실패 수(오래된 날부터). 실행이 없는 날은 0 */
export function dailyCounts(runs: readonly RunSummary[], now: Date, days = 14): DayCount[] {
  const out: DayCount[] = [];
  const index = new Map<string, DayCount>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const at = new Date(now);
    at.setDate(now.getDate() - i);
    const d: DayCount = { day: localDay(at), passed: 0, failed: 0 };
    out.push(d);
    index.set(d.day, d);
  }
  for (const r of runs) {
    if (!FINISHED.has(r.status)) continue;
    const d = index.get(localDay(new Date(r.createdAt)));
    if (!d) continue;
    if (r.status === "passed") d.passed += 1;
    else d.failed += 1;
  }
  return out;
}

export interface AttentionItem {
  tcId: string;
  target: RunSummary["target"];
  /** 그 테스트 케이스·타깃의 가장 최근에 끝난 실행 */
  latest: RunSummary;
  /** 최근부터 이어진 실패·오류 수. 마지막이 통과면 0 */
  streak: number;
}

/**
 * 테스트 케이스·타깃마다 가장 최근에 끝난 실행을 본다. 그 결과가 실패·오류이거나, 통과했지만 재시도로 통과(불안정)했으면 살펴볼 대상이다.
 * 실패가 먼저, 그다음 최근 순
 */
export function attention(runs: readonly RunSummary[]): AttentionItem[] {
  const byKey = new Map<string, RunSummary[]>();
  // runs 는 최근 순이다. 같은 키 안에서도 그 순서를 지킨다
  for (const r of [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    if (!FINISHED.has(r.status)) continue;
    const key = `${r.tcId}\u0000${r.target}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const items: AttentionItem[] = [];
  for (const list of byKey.values()) {
    const latest = list[0];
    if (!latest) continue;
    if (!isFail(latest.status) && !latest.flaky) continue;
    let streak = 0;
    for (const r of list) {
      if (!isFail(r.status)) break;
      streak += 1;
    }
    items.push({ tcId: latest.tcId, target: latest.target, latest, streak });
  }
  return items.sort((a, b) => Number(b.streak > 0) - Number(a.streak > 0) || Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}

export interface FlowCoverage {
  total: number;
  withFlow: number;
  /** 타깃 → 그 타깃 플로우가 있는 테스트 케이스 수 */
  byTarget: Record<string, number>;
}

/** 형식이 맞는 테스트 케이스 가운데 플로우가 하나라도 있는 것 */
export function flowCoverage(list: TestcaseList): FlowCoverage {
  const valid = list.testcases.filter((t) => t.valid);
  const byTarget: Record<string, number> = {};
  for (const t of valid) for (const target of t.flows) byTarget[target] = (byTarget[target] ?? 0) + 1;
  return { total: valid.length, withFlow: valid.filter((t) => t.flows.length > 0).length, byTarget };
}

export interface RunProgress {
  /** 끝난 스텝(완료·실패·경고·건너뜀) */
  done: number;
  total: number;
  /** 지금 하는(또는 다음) 스텝의 명령 */
  current: string | null;
  attempt: number;
}

/** 재생 중인 실행의 마지막 회차에서 스텝 진행. 스텝 목록이 아직 없으면 null */
export function runProgress(detail: RunDetail): RunProgress | null {
  const execution = detail.executions.at(-1);
  if (!execution || execution.steps.length === 0) return null;
  const steps = execution.steps;
  const done = steps.filter((s) => s.status !== "pending" && s.status !== "running").length;
  const current = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "pending") ?? null;
  return { done, total: steps.length, current: current?.description ?? null, attempt: execution.attempt };
}

export const AUTHOR_PHASE_TEXT: Record<AuthorJob["phase"], string> = {
  preparing: "기기와 앱을 준비하는 중",
  waiting_claude: "Claude 앱이 맡기를 기다리는 중",
  exploring: "Claude 가 화면을 탐색하는 중",
  checking: "플로우 규약을 검사하는 중",
  replaying: "두 번 재생해 확인하는 중",
  saving: "작업 브랜치에 저장하는 중",
  done: "끝남",
};

export const isActiveAuthor = (a: AuthorJob | null): a is AuthorJob => a !== null && (a.job.status === "queued" || a.job.status === "running");

/** 대시보드의 짧은 시각: "11. 10. 10:00" */
export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 경과 시간: "42초", "2분 10초" */
export function elapsed(fromIso: string | null, now: Date): string {
  if (!fromIso) return "시작 전";
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
