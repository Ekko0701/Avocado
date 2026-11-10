import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml";
import type { LintIssue } from "./lint";

/**
 * Maestro 플로우 규약 린트(PLAN 부록 B). 에이전트가 낸 플로우와 사람이 고친 플로우를 같은 규칙으로 본다.
 * 오류가 있으면 앱이 재생하거나 커밋하지 않는다.
 */
export interface FlowLintContext {
  tcId: string;
  /** env 로 쓸 수 있는 키(TC 계정 역할의 키). APP_ID 는 항상 된다 */
  envKeys: readonly string[];
  /** 플로우 폴더 기준 상대 경로로 있는 서브플로우(예: common/launch-clean.yaml) */
  subflows: readonly string[];
  /** TC 의 "기대" 수. 결과 단언이 이보다 적으면 경고 */
  expectations: number;
}

const SCREENSHOT_NAME = /^\d{2}_[a-z0-9_]+$/;
const ASSERTIONS = new Set(["assertVisible", "extendedWaitUntil"]);
// 코드를 실행하는 명령. 어디에 중첩돼 있어도(repeat·retry·runFlow.commands·onFlowStart) 쓰지 않는다
const FORBIDDEN = new Set(["runScript", "evalScript"]);
// ${…} 는 JS 식으로 평가된다. 허용한 키 이름 하나만 쓸 수 있다(값을 가공·전송하는 식 금지)
const ENV_EXPR = /\$\{([^}]*)\}/g;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COORDINATE_TEXT = /^\s*\d+%?\s*,\s*\d+%?\s*$/;

interface Command {
  name: string;
  value: Node | null;
  node: Node;
}

export function lintFlow(text: string, ctx: FlowLintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = new LineCounter();
  const lineOf = (node: Node | null | undefined): number | null => (node?.range ? lines.linePos(node.range[0]).line : null);
  const add = (level: LintIssue["level"], rule: string, message: string, node?: Node | null) => {
    issues.push({ level, rule, message, line: lineOf(node), step: null });
  };

  const split = splitFlowDocs(text, lines, issues, "appId·name·tags");
  if (!split) return issues;
  const { header, seq } = split;

  // 머리
  if (!isMap(header)) {
    add("error", "flow-header", "머리는 appId·name·tags 맵이어야 한다", header);
  } else {
    const value = (key: string): unknown => {
      const n = header.get(key, true);
      return isScalar(n) ? n.value : n;
    };
    if (value("appId") !== "${APP_ID}") add("error", "flow-header", "appId 는 ${APP_ID} 로 둔다(타깃별 앱 id 는 앱이 넣는다)", header.get("appId", true) ?? header);
    const tags = value("tags");
    const tagList = isSeq(tags) ? tags.items.map((t) => (isScalar(t) ? String(t.value) : "")) : [];
    if (!tagList.includes(ctx.tcId)) add("error", "flow-header", `tags 에 ${ctx.tcId} 가 있어야 한다`, header.get("tags", true) ?? header);
    const name = value("name");
    if (typeof name !== "string" || !name.startsWith(ctx.tcId)) add("warning", "flow-header", `name 은 "${ctx.tcId} …" 로 시작한다`, header.get("name", true) ?? header);
  }

  // 명령
  const commands = commandList(seq, add);
  if (!commands) return issues;

  const first = commands[0];
  if (first && !(first.name === "runFlow" && isScalar(first.value) && String(first.value.value).startsWith("common/"))) {
    add("warning", "flow-launch", "첫 명령은 상태를 초기화하는 공통 서브플로우(runFlow: common/…)로 한다", first.node);
  }

  let assertions = 0;
  let waitedSinceShot = false;
  for (const c of commands) {
    if (ASSERTIONS.has(c.name)) {
      assertions += 1;
      waitedSinceShot = true;
    }
    if (c.name === "takeScreenshot") {
      const shot = isScalar(c.value) ? String(c.value.value) : isMap(c.value) ? String(c.value.get("path") ?? "") : "";
      if (!SCREENSHOT_NAME.test(shot)) add("error", "flow-screenshot-name", `캡처 이름은 {NN}_{화면} 형식이다(예: 01_login): ${shot}`, c.node);
      if (!waitedSinceShot) add("error", "flow-screenshot-wait", `캡처 전에 대표 요소 대기(extendedWaitUntil·assertVisible)가 없다: ${shot}`, c.node);
      waitedSinceShot = false;
    }
  }
  if (assertions === 0) add("error", "flow-assertions", "결과 단언(assertVisible·extendedWaitUntil)이 없다");
  else if (assertions < ctx.expectations) add("warning", "flow-assertions", `테스트 케이스의 기대 ${ctx.expectations}개보다 결과 단언(${assertions}개)이 적다`);

  deepChecks(text, [header, seq], { envKeys: ctx.envKeys, subflows: ctx.subflows }, lines, issues);
  return issues;
}

/**
 * 공통 서브플로우(앱 플로우 폴더의 <타깃>/common/*.yaml) 규약. 여러 TC 플로우가 runFlow 로 부르므로 머리는 appId 만 요구하고,
 * 캡처 이름·대기·결과 단언 규칙은 TC 플로우에만 둔다. 위험한 명령·env 키·좌표·웹 주소 검사는 TC 플로우와 같다.
 * subflows 는 같은 common 폴더의 다른 파일 이름이다(Maestro 는 runFlow 경로를 부르는 파일 기준으로 푼다).
 */
export function lintSubflow(text: string, ctx: { envKeys: readonly string[]; subflows: readonly string[] }): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = new LineCounter();
  const add = (level: LintIssue["level"], rule: string, message: string, node?: Node | null) => {
    issues.push({ level, rule, message, line: node?.range ? lines.linePos(node.range[0]).line : null, step: null });
  };
  const split = splitFlowDocs(text, lines, issues, "appId");
  if (!split) return issues;
  const { header, seq } = split;
  const appId = isMap(header) ? header.get("appId", true) : null;
  if (!isScalar(appId) || appId.value !== "${APP_ID}") add("error", "flow-header", "머리에 appId: ${APP_ID} 를 둔다(타깃별 앱 id 는 앱이 넣는다)", appId ?? header);
  if (!commandList(seq, add)) return issues;
  deepChecks(text, [header, seq], { envKeys: ctx.envKeys, subflows: ctx.subflows }, lines, issues);
  return issues;
}

/** 머리와 명령 목록 두 문서로 나눈다. YAML 오류나 문서 수가 틀리면 issues 에 쓰고 null */
function splitFlowDocs(text: string, lines: LineCounter, issues: LintIssue[], headerKeys: string): { header: Node | null; seq: Node | null } | null {
  const docs = parseAllDocuments(text, { lineCounter: lines });
  if (!Array.isArray(docs)) {
    issues.push({ level: "error", rule: "flow-parse", message: "YAML 문서가 없다", line: null, step: null });
    return null;
  }
  for (const doc of docs) {
    for (const e of doc.errors) issues.push({ level: "error", rule: "flow-parse", message: `YAML 오류: ${e.message.split("\n")[0] ?? ""}`, line: lines.linePos(e.pos[0]).line, step: null });
  }
  if (issues.length > 0) return null;
  if (docs.length !== 2) {
    issues.push({ level: "error", rule: "flow-parse", message: `머리(${headerKeys})와 명령 목록을 --- 로 나눈 두 문서여야 한다`, line: null, step: null });
    return null;
  }
  return { header: (docs[0]?.contents as Node | null) ?? null, seq: (docs[1]?.contents as Node | null) ?? null };
}

/** 명령 목록의 각 항목은 이름 하나나 '이름: 값' 하나다. 목록이 아니거나 비었으면 null */
function commandList(seq: Node | null, add: (level: LintIssue["level"], rule: string, message: string, node?: Node | null) => void): Command[] | null {
  if (!isSeq(seq) || seq.items.length === 0) {
    add("error", "flow-commands", "명령 목록이 비어 있다", seq);
    return null;
  }
  const commands: Command[] = [];
  for (const item of seq.items) {
    const node = item as Node;
    if (isScalar(node) && typeof node.value === "string") commands.push({ name: node.value, value: null, node });
    else if (isMap(node) && node.items.length === 1 && isScalar(node.items[0]?.key)) {
      const pair = node.items[0];
      commands.push({ name: String((pair?.key as { value: unknown }).value), value: (pair?.value as Node | null) ?? null, node });
    } else add("error", "flow-commands", "명령은 이름 하나 또는 '이름: 값' 하나여야 한다", node);
  }
  return commands;
}

/**
 * 탐색 중 maestro_run 에 넘기는 명령(인라인 YAML, PLAN 6.3)을 실행 전에 검사한다. 머리 없이 명령 목록만 와도 된다.
 * 서브플로우 파일은 쓸 수 없다(내용을 붙여 넣는다). 오류가 하나라도 있으면 실행하지 않는다.
 */
export function lintCommandsYaml(text: string, ctx: { envKeys: readonly string[]; maxBytes?: number }): LintIssue[] {
  const issues: LintIssue[] = [];
  if (new TextEncoder().encode(text).length > (ctx.maxBytes ?? 20_000)) {
    issues.push({ level: "error", rule: "flow-size", message: "명령이 너무 길다", line: null, step: null });
    return issues;
  }
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lines });
  if (!Array.isArray(docs) || docs.length === 0 || docs.length > 2) {
    issues.push({ level: "error", rule: "flow-parse", message: "명령 목록(또는 머리 + --- + 명령 목록)이어야 한다", line: null, step: null });
    return issues;
  }
  for (const doc of docs) {
    for (const e of doc.errors) issues.push({ level: "error", rule: "flow-parse", message: `YAML 오류: ${e.message.split("\n")[0] ?? ""}`, line: lines.linePos(e.pos[0]).line, step: null });
  }
  if (issues.length > 0) return issues;
  const commands = docs.at(-1)?.contents;
  if (!isSeq(commands)) issues.push({ level: "error", rule: "flow-commands", message: "명령 목록이 아니다", line: null, step: null });
  deepChecks(text, docs.map((d) => d.contents), { envKeys: ctx.envKeys, subflows: null }, lines, issues);
  return issues;
}

/**
 * 문서 전체(머리의 onFlowStart 등 포함)를 돌며 위험한 것을 찾는다.
 * subflows 가 null 이면 서브플로우 파일 참조 자체를 막는다(탐색)
 */
function deepChecks(
  text: string,
  roots: readonly (Node | null | undefined)[],
  ctx: { envKeys: readonly string[]; subflows: readonly string[] | null },
  lines: LineCounter,
  issues: LintIssue[],
): void {
  const lineOf = (node: Node | null | undefined): number | null => (node?.range ? lines.linePos(node.range[0]).line : null);
  const add = (rule: string, message: string, node?: Node | null) => issues.push({ level: "error", rule, message, line: lineOf(node), step: null });
  const checkSubflow = (file: string, node: Node) => {
    if (ctx.subflows === null) add("flow-subflow", `탐색에서는 서브플로우 파일을 쓸 수 없다. 내용을 그대로 붙여 넣는다: ${file}`, node);
    else if (file.startsWith("/") || file.split("/").includes("..")) add("flow-subflow", `서브플로우는 플로우 폴더 안의 상대 경로다: ${file}`, node);
    else if (!ctx.subflows.includes(file)) add("flow-subflow", `없는 서브플로우다: ${file}`, node);
  };
  for (const root of roots) {
    walk(root ?? null, (node, key, parentKey) => {
      if (key !== null && FORBIDDEN.has(key)) add("flow-forbidden", `${key} 는 쓰지 않는다(코드 실행)`, node);
      if (key === null && isScalar(node) && typeof node.value === "string" && FORBIDDEN.has(node.value) && parentKey === "item") add("flow-forbidden", `${node.value} 는 쓰지 않는다(코드 실행)`, node);
      if (key === "point") add("flow-coordinates", "좌표 탭은 쓰지 않는다. 식별자가 없으면 식별자 누락으로 기록한다", node);
      if (key === "tapOn" && isScalar(node) && typeof node.value === "string" && COORDINATE_TEXT.test(node.value)) add("flow-coordinates", "좌표 탭은 쓰지 않는다", node);
      // Maestro 가 명령을 실행용으로 바꿀 때 내는 문법 오류(2.11.0 YamlFluentCommand). check-syntax 는 이 단계를 거치지 않아 통과시킨다
      if (key === "extendedWaitUntil" && !(isMap(node) && (node.has("visible") || node.has("notVisible")))) {
        add("flow-syntax", "extendedWaitUntil 에는 visible 이나 notVisible 이 있어야 한다(Maestro 문법 오류)", node);
      }
      if ((key === "runFlow" || key === "retry") && isMap(node) && node.has("file") === node.has("commands")) {
        add("flow-syntax", `${key} 에는 file 과 commands 중 하나만 둔다(Maestro 문법 오류)`, node);
      }
      if (key === "retry" && !isMap(node)) add("flow-syntax", "retry 에는 file 이나 commands 를 둔다(Maestro 문법 오류)", node);
      if (key === null && parentKey === "item" && isScalar(node) && (node.value === "extendedWaitUntil" || node.value === "retry")) {
        add("flow-syntax", `${node.value} 는 이름만으로 쓸 수 없다. 조건이나 명령을 둔다(Maestro 문법 오류)`, node);
      }
      if (key === "runFlow" && isScalar(node) && typeof node.value === "string") checkSubflow(node.value, node);
      if (key === "file" && parentKey === "runFlow" && isScalar(node) && typeof node.value === "string") checkSubflow(node.value, node);
      if (key === "openLink") {
        const link = isScalar(node) ? String(node.value) : isMap(node) ? String(node.get("link") ?? "") : "";
        if (/^\s*https?:/i.test(link)) add("flow-link", `웹 주소는 열지 않는다(앱 딥링크만): ${link}`, node);
      }
      if (key === "takeScreenshot" || (key === "path" && parentKey === "takeScreenshot")) {
        const name = isScalar(node) ? String(node.value) : "";
        if (name.includes("/") || name.includes("..")) add("flow-screenshot-name", `캡처 이름에 경로를 쓰지 않는다: ${name}`, node);
      }
    });
  }
  const allowed = new Set(["APP_ID", ...ctx.envKeys]);
  for (const m of text.matchAll(ENV_EXPR)) {
    const expr = (m[1] ?? "").trim();
    if (!IDENT.test(expr)) issues.push({ level: "error", rule: "flow-env", message: `\${…} 에는 env 키 이름 하나만 쓴다(식 금지): \${${expr.slice(0, 40)}}`, line: lines.linePos(m.index).line, step: null });
    else if (!allowed.has(expr)) issues.push({ level: "error", rule: "flow-env", message: `쓸 수 없는 env 키다: ${expr} (계정 역할의 키만)`, line: lines.linePos(m.index).line, step: null });
  }
}

/** 모든 노드를 돈다. 맵의 값이면 key 에 키 이름, parentKey 에 그 맵을 값으로 가진 키(목록 항목이면 "item") */
function walk(node: Node | null, visit: (node: Node, key: string | null, parentKey: string | null) => void, key: string | null = null, parentKey: string | null = null): void {
  if (!node) return;
  visit(node, key, parentKey);
  if (isMap(node)) {
    for (const pair of node.items) {
      const k = isScalar(pair.key) ? String(pair.key.value) : null;
      walk((pair.value as Node | null) ?? null, visit, k, key);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) walk(item as Node, visit, null, "item");
  }
}

/**
 * maestro mcp(2.11.0)의 run 은 설명과 달리 머리(appId) 없는 명령 목록을 "Config Section Required" 로 거부한다(2026-10-22 실기기 확인).
 * 머리가 없으면 `appId: ${APP_ID}` 머리를 붙인다(APP_ID 는 앱이 env 로 넣는다)
 */
export function ensureFlowHeader(text: string): string {
  const docs = parseAllDocuments(text);
  if (Array.isArray(docs) && docs.length === 1 && isSeq(docs[0]?.contents)) return `appId: \${APP_ID}\n---\n${text}`;
  return text;
}
