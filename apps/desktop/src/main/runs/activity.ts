import type { RunBatch } from "@qa/shared";

/**
 * "실행 중" 검사를 한곳에서 한다(ADR 0035 결정 4). 기기 삭제, 작업 브랜치 전환, 업데이트 설치, 플로우 만들기 시작이 이것을 본다.
 * 묶음이 도는 동안은 항목과 항목 사이(진행 중인 실행 수 0)에도 실행 중이다
 */
export function runActivity(runs: { activeCount(): number }, queue: { busy(): RunBatch | null }): () => string | null {
  return () => {
    const batch = queue.busy();
    if (batch) return `차례 실행이 진행 중이다(${batch.origin === "app" ? "실행 화면" : batch.origin})`;
    return runs.activeCount() > 0 ? "플로우 실행이 진행 중이다" : null;
  };
}
