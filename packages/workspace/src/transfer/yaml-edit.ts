import { Document, isMap, isScalar, isSeq, parseAllDocuments, parseDocument, type Node } from "yaml";
import type { Accounts, AppConfig } from "../schemas";

/** 받는 쪽 파일을 고칠 때 주석과 모양을 그대로 두고 필요한 노드만 바꾼다 */
const YAML_OUT = { lineWidth: 0, flowCollectionPadding: false } as const;

/** workspace.yaml 의 앱 목록에 앱을 더한다(주석과 목록 모양은 그대로) */
export function addAppToWorkspaceYaml(text: string, app: string): string {
  const doc = parseDocument(text);
  const apps = doc.get("apps");
  if (isSeq(apps)) apps.add(app);
  else doc.set("apps", [app]);
  return doc.toString(YAML_OUT);
}

/**
 * 앱 설정을 더하기만 하는 합치기(ADR 0036 결정 11): 받는 쪽에 없는 타깃을 더한다. 받는 쪽의 이름·언어·메모·빌드 정보는 그대로다.
 * takeTheirs 면 둘 다 있는 타깃의 앱 ID 를 받은 것으로 바꾼다
 */
export function mergeAppYaml(receiving: string, incoming: AppConfig, takeTheirs: boolean): string {
  const doc = parseDocument(receiving);
  for (const [target, config] of Object.entries(incoming.targets)) {
    if (!doc.hasIn(["targets", target])) doc.setIn(["targets", target], config);
    else if (takeTheirs) doc.setIn(["targets", target, "appId"], config.appId);
  }
  return doc.toString(YAML_OUT);
}

/** 계정 역할을 더하기만 하는 합치기: 없는 역할을 더하고, 있는 역할에는 없는 키만 더한다. 받는 쪽의 설명과 키는 그대로다 */
export function mergeAccountsYaml(receiving: string, incoming: Accounts): string {
  const parsed = parseDocument(receiving);
  // 주석만 있는(역할이 없는) 파일은 맵이 아니다. 머리 주석은 그대로 두고 빈 맵에서 시작한다
  const doc = isMap(parsed.contents) ? parsed : Object.assign(new Document({}), { commentBefore: parsed.commentBefore });
  for (const [role, entry] of Object.entries(incoming)) {
    const keys = doc.getIn([role, "keys"], true);
    if (!doc.has(role)) {
      doc.set(role, entry);
      const added = doc.getIn([role, "keys"], true);
      if (isSeq(added)) added.flow = true;
    } else if (isSeq(keys)) {
      const have = new Set(keys.items.map((k) => (isScalar(k) ? String(k.value) : "")));
      for (const key of entry.keys) if (!have.has(key)) keys.add(key);
    }
  }
  return doc.toString(YAML_OUT);
}

interface ScalarEdit {
  start: number;
  end: number;
}

/** 스칼라 노드의 원문(따옴표 포함)에서 from 을 to 로 바꾼다. 뒤에서부터 바꿔 앞의 위치가 그대로다 */
function applyEdits(text: string, edits: readonly ScalarEdit[], from: string, to: string): string | null {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    const source = out.slice(edit.start, edit.end);
    if (!source.includes(from)) return null;
    out = `${out.slice(0, edit.start)}${source.replace(from, to)}${out.slice(edit.end)}`;
  }
  return out;
}

const scalarRange = (node: unknown, offset = 0): ScalarEdit | null => (isScalar(node) && node.range ? { start: node.range[0] + offset, end: node.range[1] + offset } : null);

/**
 * 테스트 케이스 번호를 바꾼다(머리말의 id). 나머지 글자는 그대로다. 모양이 예상과 다르면 null
 */
export function renumberTestcaseText(text: string, from: string, to: string): string | null {
  const open = /^---\r?\n/.exec(text);
  if (!open) return null;
  const close = /^---[ \t]*\r?$/m.exec(text.slice(open[0].length));
  if (!close) return null;
  const start = open[0].length;
  const doc = parseDocument(text.slice(start, start + close.index));
  const id = doc.get("id", true);
  const edit = isScalar(id) && id.value === from ? scalarRange(id, start) : null;
  return edit ? applyEdits(text, [edit], from, to) : null;
}

/** 플로우 머리의 name(앞의 번호)과 tags(그 번호 항목)를 바꾼다. 모양이 예상과 다르면 null */
export function renumberFlowText(text: string, from: string, to: string): string | null {
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const header = (docs[0]?.contents as Node | null | undefined) ?? null;
  if (!isMap(header)) return null;
  const edits: ScalarEdit[] = [];
  const name = header.get("name", true);
  // TC-0001 이 TC-00012 의 앞부분으로 잡히지 않게 뒤가 숫자가 아닌지 본다
  if (isScalar(name) && typeof name.value === "string" && name.value.startsWith(from) && !/^\d/.test(name.value.slice(from.length))) {
    const edit = scalarRange(name);
    if (edit) edits.push(edit);
  }
  const tags = header.get("tags", true);
  if (!isSeq(tags)) return null;
  for (const item of tags.items) {
    const edit = isScalar(item) && item.value === from ? scalarRange(item) : null;
    if (edit) edits.push(edit);
  }
  return edits.length > 0 ? applyEdits(text, edits, from, to) : null;
}

/** 플로우 정보(meta)의 tc 를 바꾼다. 모양이 예상과 다르면 null */
export function renumberMetaText(text: string, from: string, to: string): string | null {
  const doc = parseDocument(text);
  const tc = doc.get("tc", true);
  const edit = isScalar(tc) && tc.value === from ? scalarRange(tc) : null;
  return edit ? applyEdits(text, [edit], from, to) : null;
}
