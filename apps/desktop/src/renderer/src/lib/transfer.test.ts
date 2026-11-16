import type { TransferItem } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { defaultImportReview, idRanges, importedSummary, initialPicks, lineDiff, picksToApply, requiredBy, summaryText } from "./transfer";

const item = (over: Partial<TransferItem> & Pick<TransferItem, "key" | "kind">): TransferItem => ({
  app: "notes",
  label: over.key,
  detail: "",
  status: "new",
  note: "",
  choices: ["include"],
  defaultChoice: "include",
  requires: [],
  renumberTo: null,
  compare: [],
  ...over,
});

const ITEMS: TransferItem[] = [
  item({ key: "app:notes", kind: "app", label: "앱 설정 · Notes" }),
  item({ key: "testcase:notes:TC-0001", kind: "testcase", status: "renumber", choices: ["renumber"], defaultChoice: "renumber", renumberTo: "TC-0007", requires: ["app:notes", "subflow:notes:ios:launch-clean.yaml"] }),
  item({ key: "subflow:notes:ios:launch-clean.yaml", kind: "subflow" }),
  item({ key: "testcase:demo:TC-0101", kind: "testcase", app: "demo", status: "differs", choices: ["overwrite", "renumber"], defaultChoice: null, renumberTo: "TC-0008" }),
  item({ key: "subflow:demo:ios:dismiss.yaml", kind: "subflow", app: "demo", status: "differs", choices: ["keep-ours", "take-theirs"], defaultChoice: "keep-ours" }),
  item({ key: "testcase:demo:TC-0103", kind: "testcase", app: "demo", status: "rejected", choices: [], defaultChoice: null }),
];

describe("가져오기 고르기", () => {
  it("처음 값: 처음 할 일이 있는 항목만 고르고, 내용이 다른 테스트 케이스는 첫 할 일을 보이되 고르지 않는다", () => {
    expect(initialPicks(ITEMS)).toEqual({
      "app:notes": { checked: true, action: "include" },
      "testcase:notes:TC-0001": { checked: true, action: "renumber" },
      "subflow:notes:ios:launch-clean.yaml": { checked: true, action: "include" },
      "testcase:demo:TC-0101": { checked: false, action: "overwrite" },
      "subflow:demo:ios:dismiss.yaml": { checked: true, action: "keep-ours" },
    });
  });

  it("고른 항목이 부르는 것은 고르기를 풀어도 함께 보낸다", () => {
    const picks = { ...initialPicks(ITEMS), "app:notes": { checked: false, action: "include" as const } };
    expect(requiredBy(ITEMS, picks).get("app:notes")).toEqual(["TC-0007"]);
    expect(picksToApply(ITEMS, picks).map((p) => p.key)).toEqual(["app:notes", "testcase:notes:TC-0001", "subflow:notes:ios:launch-clean.yaml", "subflow:demo:ios:dismiss.yaml"]);
    const none = { ...picks, "testcase:notes:TC-0001": { checked: false, action: "renumber" as const } };
    expect(picksToApply(ITEMS, none).map((p) => p.key)).toEqual(["subflow:notes:ios:launch-clean.yaml", "subflow:demo:ios:dismiss.yaml"]);
  });

  it("요약 줄과 번호 줄이기", () => {
    expect(summaryText({ items: ITEMS, summary: { new: 2, renumber: 1, differs: 2, same: 0, rejected: 1 } })).toBe("항목 6개 · 새로 생김 2 · 번호 바꿈 1 · 내용 다름 2 · 받지 않음 1");
    expect(idRanges(["TC-0103", "TC-0101", "TC-0102", "TC-0002", "TC-0003"])).toBe("TC-0002, TC-0003, TC-0101 ~ TC-0103");
  });

  it("가져온 것 요약과 PR 양식 처음 값: 새 번호로 넣은 것은 새 번호와 받은 번호를 함께 적는다", () => {
    const summary = importedSummary(ITEMS, picksToApply(ITEMS, initialPicks(ITEMS)));
    expect(summary.text).toBe("앱 설정 Notes, 테스트 케이스 1개(TC-0007), 공통 서브플로우 1개");
    expect(defaultImportReview("이 Mac 의 로컬 워크스페이스", summary)).toEqual({
      title: "로컬 워크스페이스에서 notes 앱과 테스트 케이스 1개를 가져온다",
      body: "## 가져온 것\n\n- 앱 설정: notes\n- 테스트 케이스: TC-0007 (받은 번호 TC-0001 에서 바꿈)\n- 공통 서브플로우: notes/ios/launch-clean.yaml\n",
    });
  });

  it("줄 비교", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "x" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
    ]);
    expect(lineDiff("x\n".repeat(3000), "y\n".repeat(3000))).toBeNull();
  });
});
