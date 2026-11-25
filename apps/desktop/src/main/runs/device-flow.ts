import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node, type Scalar, type YAMLMap } from "yaml";

/**
 * iOS 실기기(agent-device, ADR 0034)로 재생할 플로우를 점검하고 실행용 사본을 만든다.
 * - agent-device 의 Maestro 호환 명령 중 iOS 실기기에서 쓸 수 있는 것만 허용한다. 하나라도 있으면 재생하지 않는다(기기에 손대기 전에 알린다).
 * - takeScreenshot 이름에 .png 가 없으면 붙인다(실기기에서는 확장자가 없으면 캡처가 실패한다. Maestro 는 스스로 붙인다).
 * - 원본은 바꾸지 않는다. 플로우와 runFlow 로 부르는 서브플로우를 같은 상대 위치로 outDir 에 쓴다.
 */

/** agent-device 0.21.33 `help maestro` 의 지원 명령 중 iOS 실기기에서 도는 것 */
const SUPPORTED = new Set([
  "launchApp",
  "runFlow",
  "repeat",
  "retry",
  "tapOn",
  "doubleTapOn",
  "longPressOn",
  "inputText",
  "eraseText",
  "openLink",
  "hideKeyboard",
  "pressKey",
  "back",
  "assertVisible",
  "assertNotVisible",
  "assertTrue",
  "extendedWaitUntil",
  "scroll",
  "scrollUntilVisible",
  "swipe",
  "takeScreenshot",
  "waitForAnimationToEnd",
  "stopApp",
  "killApp",
  "runScript",
  "evalScript",
]);

/** 이유를 따로 알려 줄 명령(지원 목록에 없는 것) */
const REASONS: Record<string, string> = {
  clearState: "iOS 실기기에서는 앱 데이터를 지울 수 없다",
  clearKeychain: "agent-device 가 지원하지 않는다",
  setPermissions: "권한 설정은 시뮬레이터에서만 된다",
  inputRandomEmail: "agent-device 가 지원하지 않는다. 앱이 만든 값을 -e 로 넣는 식으로 바꾼다",
  inputRandomNumber: "agent-device 가 지원하지 않는다",
  inputRandomPersonName: "agent-device 가 지원하지 않는다",
  inputRandomText: "agent-device 가 지원하지 않는다",
};

export interface DeviceFlowProblem {
  /** 플로우 폴더 기준 파일 경로 */
  file: string;
  line: number;
  command: string;
  reason: string;
}

export interface PreparedDeviceFlow {
  /** outDir 안의 실행용 플로우 */
  flowPath: string;
  problems: DeviceFlowProblem[];
  /** .png 를 붙인 캡처 수 */
  renamedScreenshots: number;
}

interface Visit {
  root: string;
  outDir: string;
  problems: DeviceFlowProblem[];
  renamed: { count: number };
  seen: Set<string>;
}

/** 실행용 사본을 만들고 문제를 모은다. 문제가 있어도 사본은 쓴다(재생 여부는 부르는 쪽이 정한다) */
export function prepareDeviceFlow(flowPath: string, outDir: string): PreparedDeviceFlow {
  const root = dirname(resolve(flowPath));
  const v: Visit = { root, outDir, problems: [], renamed: { count: 0 }, seen: new Set() };
  visitFile(resolve(flowPath), v);
  return { flowPath: join(outDir, relative(root, resolve(flowPath))), problems: v.problems, renamedScreenshots: v.renamed.count };
}

function visitFile(path: string, v: Visit): void {
  if (v.seen.has(path)) return;
  v.seen.add(path);
  const rel = relative(v.root, path);
  const file = rel.split(sep).join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) {
    v.problems.push({ file, line: 1, command: "runFlow", reason: "서브플로우가 플로우 폴더 밖에 있다" });
    return;
  }
  if (!existsSync(path)) {
    v.problems.push({ file, line: 1, command: "runFlow", reason: "서브플로우 파일이 없다" });
    return;
  }
  const lines = new LineCounter();
  const docs = parseAllDocuments(readFileSync(path, "utf8"), { lineCounter: lines });
  if (!Array.isArray(docs)) throw new Error(`플로우를 읽지 못했다: ${file}`);
  const lineOf = (node: Node | null | undefined) => (node?.range ? lines.linePos(node.range[0]).line : 1);
  const at = { file, dir: dirname(path), lineOf };
  docs.forEach((doc, i) => {
    if (doc.errors.length > 0) throw new Error(`플로우 YAML 오류(${file}): ${doc.errors[0]?.message ?? ""}`);
    const contents = doc.contents;
    if (i === 0 && docs.length > 1 && isMap(contents)) {
      // 머리 문서: onFlowStart·onFlowComplete 의 명령도 본다
      for (const key of ["onFlowStart", "onFlowComplete"]) {
        const seq = contents.get(key, true);
        if (isSeq(seq)) visitCommands(seq.items as Node[], at, v);
      }
    } else if (isSeq(contents)) {
      visitCommands(contents.items as Node[], at, v);
    }
  });
  const out = join(v.outDir, rel);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, docs.map((d) => d.toString()).join(""), { mode: 0o600 });
}

interface At {
  file: string;
  dir: string;
  lineOf: (node: Node | null | undefined) => number;
}

function visitCommands(items: Node[], at: At, v: Visit): void {
  for (const item of items) {
    if (isScalar(item)) {
      check(String(item.value), null, item, at, v);
    } else if (isMap(item)) {
      for (const pair of item.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : "";
        check(key, (pair.value as Node | null) ?? null, item, at, v);
      }
    }
  }
}

function check(command: string, arg: Node | null, node: Node, at: At, v: Visit): void {
  const line = at.lineOf(node);
  if (!SUPPORTED.has(command)) {
    v.problems.push({ file: at.file, line, command, reason: REASONS[command] ?? "iOS 실기기 재생(agent-device)이 지원하지 않는 명령이다" });
    return;
  }
  if (command === "launchApp" && isMap(arg)) {
    if (truthy(arg.get("clearState", true))) v.problems.push({ file: at.file, line, command: "launchApp.clearState", reason: REASONS["clearState"] ?? "" });
    if (arg.has("permissions")) v.problems.push({ file: at.file, line, command: "launchApp.permissions", reason: REASONS["setPermissions"] ?? "" });
    if (truthy(arg.get("clearKeychain", true))) v.problems.push({ file: at.file, line, command: "launchApp.clearKeychain", reason: REASONS["clearKeychain"] ?? "" });
  }
  if (command === "takeScreenshot") renameScreenshot(arg, v);
  if (command === "runFlow") {
    if (isScalar(arg)) visitFile(resolve(at.dir, String(arg.value)), v);
    else if (isMap(arg)) {
      const file = arg.get("file", true);
      if (isScalar(file)) visitFile(resolve(at.dir, String(file.value)), v);
      const commands = arg.get("commands", true);
      if (isSeq(commands)) visitCommands(commands.items as Node[], at, v);
    }
  }
  if ((command === "repeat" || command === "retry") && isMap(arg)) {
    const commands = arg.get("commands", true);
    if (isSeq(commands)) visitCommands(commands.items as Node[], at, v);
    if (command === "retry") {
      const file = arg.get("file", true);
      if (isScalar(file)) visitFile(resolve(at.dir, String(file.value)), v);
    }
  }
}

function truthy(node: unknown): boolean {
  return isScalar(node) && (node.value === true || node.value === "true");
}

function renameScreenshot(arg: Node | null, v: Visit): void {
  const target: Scalar | null = isScalar(arg) ? arg : isMap(arg) ? (((arg as YAMLMap).get("path", true) as Scalar | undefined) ?? null) : null;
  if (!target || typeof target.value !== "string") return;
  if (target.value.toLowerCase().endsWith(".png")) return;
  target.value = `${target.value}.png`;
  v.renamed.count += 1;
}

/** 문제 목록을 사람이 읽을 한 문단으로 */
export function describeProblems(problems: readonly DeviceFlowProblem[]): string {
  const shown = problems.slice(0, 5).map((p) => `${p.file}:${p.line} ${p.command}(${p.reason})`);
  const more = problems.length > 5 ? ` 외 ${problems.length - 5}개` : "";
  return `iOS 실기기에서 재생할 수 없는 명령이 있다: ${shown.join(", ")}${more}. 실기기용 플로우·서브플로우를 따로 두거나 이 명령을 뺀다`;
}
