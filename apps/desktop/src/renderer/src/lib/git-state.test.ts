import type { MyPullRequest, WorkBranch } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { branchTarget, defaultReview, groupGitWork, inProgressCount } from "./git-state";

const branch = (over: Partial<WorkBranch> & { name: string }): WorkBranch => ({ tcId: null, appSettings: null, current: false, ahead: 1, subject: "tc: TC-0102 add TC-0102", pending: true, ...over });
const pull = (number: number, name: string): MyPullRequest => ({ number, title: `PR ${number}`, url: `https://github.com/acme/qa-workspace/pull/${number}`, branch: name, createdAt: "2026-11-08T01:00:00Z" });

describe("Git 상태 묶기", () => {
  const tc = branch({ name: "qa/me/TC-0102-add", tcId: "TC-0102", ahead: 2 });
  const flow = branch({ name: "qa/me/TC-0101-agent-flow", tcId: "TC-0101", subject: "flow: TC-0101 agent flow" });
  const app = branch({ name: "qa/me/app/demo/add-role", appSettings: "demo", subject: "app: demo add role" });
  const merged = branch({ name: "qa/me/TC-0002-fix", tcId: "TC-0002", ahead: 0, pending: false });

  it("열린 PR 이 있는 브랜치는 PR 쪽에, 없는 것은 커밋 쪽에, main 에 반영된 것은 따로 둔다", () => {
    const work = groupGitWork([tc, flow, app, merged], [pull(7, flow.name)]);
    expect(work.unpublished.map((b) => b.name)).toEqual([tc.name, app.name]);
    expect(work.open).toEqual([{ pull: pull(7, flow.name), branch: flow }]);
    expect(work.merged.map((b) => b.name)).toEqual([merged.name]);
  });

  it("이 Mac 에 브랜치가 없는 PR 도 보이고, 스쿼시 머지 뒤 남은 PR 브랜치는 반영됨에 넣지 않는다", () => {
    const work = groupGitWork([merged], [pull(9, "qa/me/TC-0300-other-mac"), pull(10, merged.name)]);
    expect(work.open.map((o) => [o.pull.number, o.branch?.name ?? null])).toEqual([
      [9, null],
      [10, merged.name],
    ]);
    expect(work.merged).toEqual([]);
  });

  it("PR 목록을 읽지 못하면 올릴 변경이 있는 브랜치를 모두 커밋 쪽에 둔다", () => {
    const work = groupGitWork([tc, flow, merged], null);
    expect(work.unpublished.map((b) => b.name)).toEqual([tc.name, flow.name]);
    expect(work.open).toEqual([]);
  });

  it("배지는 main 에 없는 변경이 있는 브랜치 수다", () => {
    expect(inProgressCount([tc, flow, app, merged])).toBe(3);
    expect(inProgressCount([])).toBe(0);
  });

  it("대상 이름과 PR 기본값", () => {
    expect(branchTarget(tc)).toBe("TC-0102");
    expect(branchTarget(app)).toBe("앱 설정 · demo");
    expect(branchTarget(branch({ name: "qa/me/workspace/layout-v2" }))).toBe("폴더 구조");
    expect(defaultReview(flow)).toEqual({ title: "TC-0101 agent flow", body: `## 변경\n\n- 작업 브랜치: ${flow.name}\n` });
  });
});
