import type { ArchiveProblemCode, ImportPreview, TransferAction, TransferItem, TransferItemStatus } from "@qa/shared";

/** 워크스페이스 내보내기·가져오기 화면의 순수 도우미(ADR 0036 결정 11) */

export const STATUS_BADGE: Record<TransferItemStatus, { label: string; className: string }> = {
  new: { label: "새로 생김", className: "badge ok" },
  renumber: { label: "번호 바꿈", className: "badge warn" },
  differs: { label: "내용 다름", className: "badge warn" },
  same: { label: "같음", className: "badge" },
  rejected: { label: "받지 않음", className: "badge bad" },
};

const SUMMARY_ORDER: TransferItemStatus[] = ["new", "renumber", "differs", "same", "rejected"];

/** "항목 8개 · 새로 생김 2 · 번호 바꿈 2 …" (없는 상태는 뺀다) */
export function summaryText(preview: Pick<ImportPreview, "items" | "summary">): string {
  return [`항목 ${preview.items.length}개`, ...SUMMARY_ORDER.filter((s) => preview.summary[s] > 0).map((s) => `${STATUS_BADGE[s].label} ${preview.summary[s]}`)].join(" · ");
}

export const PROBLEM_BADGE: Record<ArchiveProblemCode, string> = {
  link: "링크",
  collision: "이름 겹침",
  path: "경로",
  size: "크기",
  name: "이름",
  type: "종류",
  encrypted: "암호",
  method: "압축",
  count: "개수",
  format: "형식",
  layout: "구조",
};

export function actionLabel(action: TransferAction, item: Pick<TransferItem, "renumberTo">): string {
  switch (action) {
    case "include":
      return "가져오기";
    case "overwrite":
      return "같은 테스트, 받은 것으로 덮어쓰기";
    case "renumber":
      return `다른 테스트, 새 번호${item.renumberTo ? `(${item.renumberTo})` : ""}로 가져오기`;
    case "keep-ours":
      return "이 워크스페이스 것 그대로 두기";
    case "take-theirs":
      return "받은 것으로 바꾸기";
  }
}

/** 고르기 칸 이름에 쓰는 짧은 이름: 테스트 케이스는 번호, 서브플로우는 파일 이름 */
export function shortName(item: Pick<TransferItem, "key" | "kind" | "label">): string {
  const last = item.key.split(":").at(-1) ?? item.key;
  return item.kind === "app" ? item.label : last;
}

export type PickState = Record<string, { checked: boolean; action: TransferAction }>;

/** 처음 고른 상태: 처음 할 일이 있는 항목은 골라 두고, 없는 항목(내용 다른 테스트 케이스)은 첫 할 일을 보이되 고르지 않는다 */
export function initialPicks(items: readonly TransferItem[]): PickState {
  const out: PickState = {};
  for (const item of items) {
    const action = item.defaultChoice ?? item.choices[0];
    if (action) out[item.key] = { checked: item.defaultChoice !== null, action };
  }
  return out;
}

/** 고른 항목이 함께 들여오는 항목 → 그것을 부르는 고른 항목의 이름(새 번호로 넣는 테스트 케이스는 새 번호) */
export function requiredBy(items: readonly TransferItem[], picks: PickState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of items) {
    const pick = picks[item.key];
    if (!pick?.checked) continue;
    const name = pick.action === "renumber" && item.renumberTo ? item.renumberTo : shortName(item);
    for (const need of item.requires) out.set(need, [...(out.get(need) ?? []), name]);
  }
  return out;
}

/** main 에 보낼 고른 항목: 직접 고른 것과 함께 들어가는 것 */
export function picksToApply(items: readonly TransferItem[], picks: PickState): { key: string; action: TransferAction }[] {
  const required = requiredBy(items, picks);
  return items.flatMap((item) => {
    const state = picks[item.key];
    return state && (state.checked || required.has(item.key)) ? [{ key: item.key, action: state.action }] : [];
  });
}

/** 번호를 줄여 쓴다: 셋 이상 이어지면 "TC-0101 ~ TC-0103" */
export function idRanges(ids: readonly string[]): string {
  const nums = [...new Set(ids)].map((id) => ({ id, n: Number(/^TC-(\d+)$/.exec(id)?.[1] ?? Number.NaN) })).sort((a, b) => a.n - b.n);
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && (nums[j + 1]?.n ?? 0) === (nums[j]?.n ?? 0) + 1) j += 1;
    if (j - i >= 2) parts.push(`${nums[i]?.id ?? ""} ~ ${nums[j]?.id ?? ""}`);
    else for (let k = i; k <= j; k += 1) parts.push(nums[k]?.id ?? "");
    i = j + 1;
  }
  return parts.join(", ");
}

/** 가져온 뒤 보일 것: 들어간 테스트 케이스 번호(새 번호로 넣은 것은 새 번호), 앱 설정, 서브플로우 */
export function importedSummary(items: readonly TransferItem[], picked: readonly { key: string; action: TransferAction }[]) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const chosen = picked.filter((p) => p.action !== "keep-ours").flatMap((p) => {
    const item = byKey.get(p.key);
    return item ? [{ item, action: p.action }] : [];
  });
  // 테스트 케이스 항목의 키는 testcase:<앱>:<번호> 다
  const testcases = chosen.filter((c) => c.item.kind === "testcase").map((c) => ({ from: shortName(c.item), to: c.action === "renumber" ? (c.item.renumberTo ?? "") : shortName(c.item) }));
  const apps = chosen.filter((c) => c.item.kind === "app").map((c) => ({ app: c.item.app, name: c.item.label.replace(/^앱 설정 · /, "") }));
  // 서브플로우 항목의 키는 subflow:<앱>:<타깃>:<이름> 이다
  const subflows = chosen.filter((c) => c.item.kind === "subflow").map((c) => c.item.key.split(":").slice(1).join("/"));
  testcases.sort((a, b) => a.to.localeCompare(b.to));
  const parts = [
    ...apps.map((a) => `앱 설정 ${a.name}`),
    testcases.length ? `테스트 케이스 ${testcases.length}개(${testcases.map((t) => t.to).join(", ")})` : null,
    subflows.length ? `공통 서브플로우 ${subflows.length}개` : null,
  ].filter((s): s is string => s !== null);
  return { testcases, apps, subflows, text: parts.join(", ") };
}

/** GitHub 방식 가져오기 뒤 PR 양식의 처음 값 */
export function defaultImportReview(sourceLabel: string, summary: ReturnType<typeof importedSummary>): { title: string; body: string } {
  const from = sourceLabel === "이 Mac 의 로컬 워크스페이스" ? "로컬 워크스페이스" : sourceLabel;
  const what = [summary.apps.length ? `${summary.apps.map((a) => a.app).join(", ")} 앱` : null, summary.testcases.length ? `테스트 케이스 ${summary.testcases.length}개` : null, summary.subflows.length && !summary.apps.length && !summary.testcases.length ? `공통 서브플로우 ${summary.subflows.length}개` : null]
    .filter(Boolean)
    .join("과 ");
  const renumbered = summary.testcases.filter((t) => t.from !== t.to);
  const lines = [
    "## 가져온 것",
    "",
    ...(summary.apps.length ? [`- 앱 설정: ${summary.apps.map((a) => a.app).join(", ")}`] : []),
    ...(summary.testcases.length ? [`- 테스트 케이스: ${summary.testcases.map((t) => t.to).join(", ")}${renumbered.length ? ` (받은 번호 ${renumbered.map((t) => t.from).join(", ")} 에서 바꿈)` : ""}`] : []),
    ...(summary.subflows.length ? [`- 공통 서브플로우: ${summary.subflows.join(", ")}`] : []),
  ];
  return { title: `${from}에서 ${what || "항목"}를 가져온다`, body: `${lines.join("\n")}\n` };
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

const DIFF_LIMIT = 4_000_000;

/** 줄 단위 비교(가장 긴 공통 부분열). 너무 크면 null(화면은 두 글을 나란히 보인다) */
export function lineDiff(ours: string, theirs: string): DiffLine[] | null {
  const a = ours.split("\n");
  const b = theirs.split("\n");
  if (a.length * b.length > DIFF_LIMIT) return null;
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      row[j] = a[i] === b[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))) {
      out.push({ kind: "add", text: b[j] ?? "" });
      j += 1;
    } else {
      out.push({ kind: "del", text: a[i] ?? "" });
      i += 1;
    }
  }
  return out;
}
