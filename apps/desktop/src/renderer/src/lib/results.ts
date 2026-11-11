import type { RunSummary } from "@qa/shared";

/** 결과 화면 왼쪽 목록의 상태 칩. 실패는 오류를 포함한다 */
export type RunFilter = "all" | "failed" | "passed";

const isFail = (s: RunSummary["status"]) => s === "failed" || s === "error";
export const TARGET_LABEL: Record<RunSummary["target"], string> = { ios: "iOS", android: "Android" };

export const runTitle = (r: Pick<RunSummary, "flowName" | "tcId">) => (r.flowName.includes(r.tcId) ? r.flowName : `${r.tcId} · ${r.flowName}`);

export function filterCounts(runs: readonly RunSummary[]): Record<RunFilter, number> {
  return { all: runs.length, failed: runs.filter((r) => isFail(r.status)).length, passed: runs.filter((r) => r.status === "passed").length };
}

/** 상태 칩과 검색어(테스트 케이스 ID·이름·기기·타깃, 대소문자 무시)로 거른다 */
export function filterRuns(runs: readonly RunSummary[], filter: RunFilter, query: string): RunSummary[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter((r) => {
    if (filter === "failed" && !isFail(r.status)) return false;
    if (filter === "passed" && r.status !== "passed") return false;
    const hay = `${r.tcId} ${r.flowName} ${r.deviceName} ${TARGET_LABEL[r.target]}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface MatrixRow {
  tcId: string;
  title: string;
  ios?: RunSummary;
  android?: RunSummary;
}

/** 테스트 케이스·타깃마다 가장 최근 실행. runs 는 최근 순이다 */
export function latestMatrix(runs: readonly RunSummary[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const r of runs) {
    const row = rows.get(r.tcId) ?? { tcId: r.tcId, title: r.flowName.replace(r.tcId, "").trim() || r.flowName };
    if (!row[r.target]) row[r.target] = r;
    rows.set(r.tcId, row);
  }
  return [...rows.values()];
}

/** 걸린 시간: "0.8초", "48초", "1분 22초" */
export function durationText(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}초`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
