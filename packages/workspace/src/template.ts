import type { Target } from "./schemas";
import { serializeTestcase } from "./serialize";

/** 새 TC 의 다음 id. 앱과 상관없이 워크스페이스 전체에서 가장 큰 번호 + 1 */
export function nextTestcaseId(existing: readonly string[]): string {
  const max = existing.reduce((m, id) => Math.max(m, Number(/^TC-(\d+)$/.exec(id)?.[1] ?? 0)), 0);
  return `TC-${String(max + 1).padStart(4, "0")}`;
}

/** 기획자용 TC 템플릿(PLAN 4.2). 각 칸을 바꿔 쓰게 예시 문장을 넣는다 */
export function testcaseTemplate(input: { id: string; app: string; targets: Target[]; account?: string }): string {
  return serializeTestcase({
    frontMatter: { id: input.id, title: "무엇을 확인하는지 한 줄로 쓴다", app: input.app, targets: input.targets, priority: "medium", tags: [], ...(input.account ? { account: input.account } : {}), status: "draft" },
    preconditions: ["시작 상태를 쓴다(예: 로그인 전 홈 화면)"],
    steps: [
      { action: "'버튼 이름'을 탭한다", expected: ["그 결과 화면에 보여야 할 것을 쓴다"] },
      { action: "'입력란 이름'에 값을 입력하고 '버튼 이름'을 탭한다", expected: ["다음 화면과 보여야 할 문구"] },
    ],
    doneCriteria: ["TC 가 끝났다고 볼 화면 상태"],
  });
}
