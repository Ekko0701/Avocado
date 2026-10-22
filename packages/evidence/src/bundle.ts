import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseExecution } from "./parse";
import { buildSecretSet, findResidueInFiles, redactText, type Residue } from "./redact";

/**
 * 증적 요약 묶음(PLAN 9.2). 가린 사본(redacted/)에서만 만들고, 만든 뒤 모든 텍스트를 한 번 더 가린다.
 * 영상·원본 로그·원본 트리는 넣지 않는다. 업로드 전 검사(checkBundle)에서 비밀 값이 나오면 막는다(9.3).
 */
export const BUNDLE_MAX_BYTES = 20 * 1024 * 1024;
const LOG_CONTEXT = 200;

export interface BundleMeta {
  runId: string;
  executionId: string;
  attempt: number;
  tcId: string;
  app: string;
  target: "ios" | "android";
  flowName: string;
  deviceName: string;
  buildLabel: string | null;
  /** 실행(run) 최종 결과 */
  result: "passed" | "failed" | "error" | "canceled";
  flaky: boolean;
  failureClass: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** 예: "qa-tool 0.1.0" */
  generator: string;
}

export type BundleFileKind = "run_json" | "report" | "screen" | "failure_screen" | "hierarchy" | "log";

export interface BundleFile {
  /** 묶음 폴더 기준 경로 */
  path: string;
  kind: BundleFileKind;
  content: Buffer;
}

export interface SummaryBundle {
  /** 증적 저장소 안의 묶음 폴더: runs/YYYY/MM/DD/<runId>/<execId> */
  root: string;
  files: BundleFile[];
  totalBytes: number;
  warnings: string[];
  /** index/YYYY-MM.jsonl 에 덧붙일 한 줄 */
  indexLine: string;
  indexPath: string;
}

export type JpegConverter = (png: Buffer, options: { maxSide: number; quality: number }) => Promise<Buffer>;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export interface BuildBundleOptions {
  meta: BundleMeta;
  /** 실행 폴더의 가린 사본 */
  redactedDir: string;
  /** 통과 실행의 화면 캡처도 넣는다(기본 제외, 9.2) */
  includePassScreens: boolean;
  /** 키체인의 계정 값·토큰 등 가릴 값 */
  secrets: readonly string[];
  toJpeg: JpegConverter;
  maxBytes?: number;
  /** 저장 위치의 날짜(현지 시간) */
  date: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");
const sizeOf = (files: readonly BundleFile[]) => files.reduce((n, f) => n + f.content.length, 0);

export async function buildSummaryBundle(options: BuildBundleOptions): Promise<SummaryBundle> {
  const { meta, date } = options;
  const parsed = parseExecution({ dir: options.redactedDir });
  const failed = meta.result !== "passed" || parsed.status !== "passed";
  const set = buildSecretSet(options.secrets);
  const redact = (text: string) => redactText(text, set).text;
  const warnings: string[] = [];
  const day = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const root = `runs/${day}/${meta.runId}/${meta.executionId}`;

  const read = (rel: string) => readFileSync(join(options.redactedDir, rel));
  const failedStep = parsed.failure?.stepIndex ?? null;

  // 캡처: 통과 실행의 화면 캡처는 옵션, 실패 실행은 화면 캡처와 실패 스텝 캡처
  const screenSources = parsed.artifacts.filter((a) => a.kind === "take_screenshot" && (failed || options.includePassScreens));
  const failureSources = failed ? parsed.artifacts.filter((a) => a.kind === "failure_screenshot") : [];
  const images: { path: string; kind: "screen" | "failure_screen"; png: Buffer }[] = [
    ...screenSources.map((a) => ({ path: `screens/${basename(a.path).replace(/\.png$/i, "")}.jpg`, kind: "screen" as const, png: read(a.path) })),
    ...failureSources.map((a) => ({ path: `screens/failure-step-${pad((a.stepIndex ?? 0) + 1)}.jpg`, kind: "failure_screen" as const, png: read(a.path) })),
  ];

  const text: BundleFile[] = [];
  if (failed) {
    const hierarchy = parsed.artifacts.find((a) => a.kind === "screen_hierarchy" && (failedStep === null || a.stepIndex === failedStep));
    if (hierarchy) text.push({ path: `hierarchy/failure-step-${pad((hierarchy.stepIndex ?? 0) + 1)}.json`, kind: "hierarchy", content: Buffer.from(redact(read(hierarchy.path).toString("utf8"))) });
    const log = parsed.artifacts.find((a) => a.kind === "maestro_log");
    if (log) text.push({ path: "logs/maestro-excerpt.txt", kind: "log", content: Buffer.from(redact(excerpt(read(log.path).toString("utf8"), parsed.failure?.message ?? null))) });
    const consoleLog = parsed.artifacts.find((a) => a.kind === "console_log");
    if (consoleLog) text.push({ path: "logs/console-tail.txt", kind: "log", content: Buffer.from(redact(tail(read(consoleLog.path).toString("utf8"), LOG_CONTEXT))) });
  }

  const steps = parsed.steps.map((s) => ({ index: s.index, description: redact(s.description), status: s.status, durationMs: s.durationMs, error: s.error ? redact(s.error.message) : null }));
  const failure = parsed.failure ? { kind: parsed.failure.kind, message: redact(parsed.failure.message), stepIndex: parsed.failure.stepIndex } : null;

  const encode = async (maxSide: number, quality: number) =>
    Promise.all(images.map(async (img) => ({ path: img.path, kind: img.kind, content: await options.toJpeg(img.png, { maxSide, quality }) }) satisfies BundleFile));
  let screens: BundleFile[] = await encode(720, 70);

  const compose = (list: BundleFile[]): BundleFile[] => {
    const runJson = {
      schemaVersion: 1,
      ...meta,
      executionStatus: parsed.status,
      durationMs: parsed.durationMs,
      failure,
      steps,
      files: [...list.map((f) => f.path), ...text.map((f) => f.path)],
    };
    return [
      { path: "run.json", kind: "run_json", content: Buffer.from(redact(`${JSON.stringify(runJson, null, 2)}\n`)) },
      { path: "report.md", kind: "report", content: Buffer.from(redact(report(meta, parsed.status, failure, steps, list, text))) },
      ...list,
      ...text,
    ];
  };

  // 20MB 를 넘으면 캡처를 줄인다: 더 작게 → 실패 캡처만(9.2)
  const max = options.maxBytes ?? BUNDLE_MAX_BYTES;
  let files = compose(screens);
  if (sizeOf(files) > max && screens.length > 0) {
    screens = await encode(480, 50);
    files = compose(screens);
    warnings.push("묶음이 커서 캡처를 480px·품질 50 으로 줄였다");
  }
  if (sizeOf(files) > max && screens.some((s) => s.kind === "screen")) {
    screens = screens.filter((s) => s.kind === "failure_screen");
    files = compose(screens);
    warnings.push("묶음이 커서 화면 캡처를 빼고 실패 캡처만 넣었다");
  }
  if (sizeOf(files) > max) throw new BundleError(`요약 묶음이 상한(${(max / 1024 / 1024).toFixed(1)}MB)을 넘는다(${(sizeOf(files) / 1024 / 1024).toFixed(1)}MB)`);

  const indexLine = JSON.stringify({
    runId: meta.runId,
    executionId: meta.executionId,
    date: date.toISOString(),
    tcId: meta.tcId,
    app: meta.app,
    target: meta.target,
    result: meta.result,
    flaky: meta.flaky,
    failureClass: meta.failureClass,
    device: meta.deviceName,
    build: meta.buildLabel,
    path: root,
  });
  return { root, files, totalBytes: sizeOf(files), warnings, indexLine: redact(indexLine), indexPath: `index/${date.getFullYear()}-${pad(date.getMonth() + 1)}.jsonl` };
}

/** 업로드 직전 검사(PLAN 9.3 의 2). 하나라도 나오면 업로드하지 않는다 */
export function checkBundle(bundle: SummaryBundle, secrets: readonly string[]): Residue[] {
  return findResidueInFiles([...bundle.files, { path: bundle.indexPath, content: Buffer.from(bundle.indexLine) }], secrets);
}

function tail(text: string, lines: number): string {
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/** 실패 시점 전후 200줄. 실패 메시지가 나온 줄, 없으면 마지막 FAILED·Exception 줄, 그것도 없으면 끝 */
function excerpt(text: string, failureMessage: string | null): string {
  const lines = text.split("\n");
  const probe = failureMessage?.split("\n")[0]?.slice(0, 80) ?? "";
  let at = probe ? lines.findIndex((l) => l.includes(probe)) : -1;
  if (at < 0) at = lines.findLastIndex((l) => /FAILED|Exception|Error/.test(l));
  if (at < 0) at = lines.length - 1;
  const from = Math.max(0, at - LOG_CONTEXT);
  const to = Math.min(lines.length, at + LOG_CONTEXT + 1);
  return `# maestro.log ${from + 1}~${to}줄 (전체 ${lines.length}줄)\n${lines.slice(from, to).join("\n")}`;
}

const RESULT_LABEL: Record<string, string> = { passed: "통과", failed: "실패", error: "오류", canceled: "취소" };
const STEP_LABEL: Record<string, string> = { completed: "완료", failed: "실패", warned: "경고", skipped: "건너뜀", pending: "대기", running: "실행 중" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function report(
  meta: BundleMeta,
  executionStatus: string,
  failure: { kind: string; message: string; stepIndex: number | null } | null,
  steps: { index: number; description: string; status: string; durationMs: number | null; error: string | null }[],
  screens: BundleFile[],
  text: BundleFile[],
): string {
  const lines = [
    `# ${meta.tcId} ${meta.flowName} — ${RESULT_LABEL[meta.result] ?? meta.result}${meta.flaky ? " (불안정)" : ""}`,
    "",
    `| 항목 | 값 |`,
    `|---|---|`,
    `| 앱·타깃 | ${cell(meta.app)} · ${meta.target} |`,
    `| 기기 | ${cell(meta.deviceName)} |`,
    `| 빌드 | ${cell(meta.buildLabel ?? "기기에 설치된 앱")} |`,
    `| 실행 | ${meta.runId} / ${meta.executionId} (시도 ${meta.attempt}) |`,
    `| 시각 | ${meta.createdAt}${meta.finishedAt ? ` ~ ${meta.finishedAt}` : ""} |`,
    `| 실행 결과 | ${executionStatus}${meta.failureClass ? ` · 분류 ${meta.failureClass}` : ""} |`,
    "",
  ];
  if (failure) lines.push("## 실패", "", `- 종류: ${failure.kind}`, `- 스텝: ${failure.stepIndex === null ? "-" : failure.stepIndex + 1}`, `- 메시지: ${cell(failure.message)}`, "");
  lines.push("## 스텝", "", "| # | 명령 | 결과 | 시간 |", "|---|---|---|---|");
  for (const s of steps) {
    lines.push(`| ${s.index + 1} | ${cell(s.description)}${s.error ? `<br>${cell(s.error)}` : ""} | ${STEP_LABEL[s.status] ?? s.status} | ${s.durationMs === null ? "" : `${(s.durationMs / 1000).toFixed(1)}초`} |`);
  }
  if (screens.length > 0) {
    lines.push("", "## 캡처", "");
    for (const s of screens) lines.push(`![${s.path}](${encodeURI(s.path)})`);
  }
  if (text.length > 0) {
    lines.push("", "## 첨부", "");
    for (const f of text) lines.push(`- [${f.path}](${encodeURI(f.path)})`);
  }
  lines.push("", `_${meta.generator} 가 가림 사본으로 만든 요약입니다. 원본 증적과 영상은 올리지 않습니다._`, "");
  return lines.join("\n");
}
