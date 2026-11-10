import type { MyPullRequest, WorkBranch } from "@qa/shared";

/** Git 상태 인스펙터의 종류별 묶음 */
export interface GitWork {
  /** main 에 없는 커밋이 있고 열린 PR 이 없는 작업 브랜치 */
  unpublished: WorkBranch[];
  /** 내 열린 PR. 이 Mac 에 그 브랜치가 있으면 같이 둔다(다른 Mac 에서 올린 PR 은 null) */
  open: { pull: MyPullRequest; branch: WorkBranch | null }[];
  /** main 에 반영된(또는 빈) 작업 브랜치 */
  merged: WorkBranch[];
}

/** 작업 브랜치와 내 열린 PR 을 종류별로 나눈다. PR 목록을 읽지 못했으면(null) 올릴 변경이 있는 브랜치를 모두 "PR 을 올리지 않음"에 둔다 */
export function groupGitWork(branches: readonly WorkBranch[], pulls: readonly MyPullRequest[] | null): GitWork {
  const open = (pulls ?? []).map((pull) => ({ pull, branch: branches.find((b) => b.name === pull.branch) ?? null }));
  const withPull = new Set(open.map((o) => o.pull.branch));
  return {
    unpublished: branches.filter((b) => b.pending && !withPull.has(b.name)),
    open,
    merged: branches.filter((b) => !b.pending && !withPull.has(b.name)),
  };
}

/** 툴바 배지: main 에 아직 없는 변경이 있는 작업 브랜치 수(PR 을 올렸든 아니든) */
export function inProgressCount(branches: readonly WorkBranch[]): number {
  return branches.filter((b) => b.pending).length;
}

/** 작업 브랜치가 다루는 대상: TC id, 앱 설정, 폴더 구조 */
export function branchTarget(b: WorkBranch): string {
  if (b.tcId) return b.tcId;
  if (b.appSettings) return `앱 설정 · ${b.appSettings}`;
  if (/^qa\/[^/]+\/workspace\//.test(b.name)) return "폴더 구조";
  return "작업 브랜치";
}

/** PR 작성 양식의 기본값: 마지막 커밋 제목에서 종류 머리말(tc:, flow: …)을 뗀다 */
export function defaultReview(b: WorkBranch): { title: string; body: string } {
  return { title: b.subject.replace(/^[a-z]+: /, ""), body: `## 변경\n\n- 작업 브랜치: ${b.name}\n` };
}
