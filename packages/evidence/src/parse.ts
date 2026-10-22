import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { exceptionMessage, isDriverFailure } from "./console";
import { describeCommand } from "./describe";
import { junitPassed, parseJUnit, type JUnitCase, type JUnitReport } from "./junit";
import { ApplyConfigurationSchema, MaestroCommandsSchema, MaestroManifestSchema, type MaestroManifest } from "./maestro-schema";
import { EvidenceParseError, ParsedExecutionSchema, type Artifact, type ArtifactKind, type Failure, type ParsedExecution, type Step } from "./model";
import { pngSize } from "./png";
import { listFiles } from "./walk";

/** 실행 하나의 증적 폴더 구조. 실행 엔진(T-107)이 이 이름으로 남긴다. */
export const EXECUTION_LAYOUT = {
  console: "console.log",
  junit: "junit.xml",
  exitCode: "exit-code",
  /** maestro --test-output-dir */
  maestro: "maestro",
} as const;

/** 내부 설정 명령. 스텝 목록에서 뺀다 */
const SETUP_COMMANDS = new Set(["defineVariablesCommand", "applyConfigurationCommand"]);
/** Maestro 세션 폴더 이름: 2026-10-21_151532 */
const SESSION_DIR = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

export interface ParseExecutionInput {
  /** 실행 폴더. 산출물 경로는 이 폴더 기준으로 돌려준다 */
  dir: string;
  /** maestro --test-output-dir. 기본 <dir>/maestro */
  outputDir?: string;
  /** 기본 <dir>/console.log (없으면 무시) */
  consoleLog?: string;
  /** 기본 <dir>/junit.xml (없으면 무시) */
  junit?: string;
  /** maestro 종료 코드. 주지 않으면 <dir>/exit-code 를 읽고, 없으면 모른다(null) */
  exitCode?: number | null;
}

const nfc = (s: string) => s.normalize("NFC");

function readText(path: string | undefined): string | null {
  return path && existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new EvidenceParseError(`${what} 를 읽지 못했다(${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function headBytes(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function findFlowDirs(outputDir: string): { sessions: string[]; flows: string[] } {
  if (!existsSync(outputDir)) return { sessions: [], flows: [] };
  const sessions = readdirSync(outputDir)
    .filter((n) => SESSION_DIR.test(n) && statSync(join(outputDir, n)).isDirectory())
    .sort()
    .map((n) => join(outputDir, n));
  const flows = sessions.flatMap((s) =>
    readdirSync(s)
      .filter((n) => statSync(join(s, n)).isDirectory())
      .sort()
      .map((n) => join(s, n)),
  );
  return { sessions, flows };
}

function platformOf(manifest: MaestroManifest | null, junit: JUnitReport | null, hasRunnerLog: boolean): "ios" | "android" | null {
  for (const e of manifest?.entries ?? []) {
    const source = e.metadata?.["source"];
    if (source === "simulator" || source === "xctest") return "ios";
    if (source === "emulator" || source === "device" || source === "logcat") return "android";
  }
  if (junit?.device) {
    if (/\biOS\b/i.test(junit.device)) return "ios";
    if (/\bAndroid\b/i.test(junit.device)) return "android";
  }
  return hasRunnerLog ? "ios" : null;
}

/**
 * Maestro 실행 하나의 산출물을 스텝·산출물·결과로 바꾼다(PLAN 7.6).
 * - 플로우 폴더가 없으면(드라이버 시작 실패 등) 콘솔 출력으로 원인을 정한다.
 * - commands.json 이 없거나 형식이 다르면 EvidenceParseError. 빈 스텝으로 통과시키지 않는다.
 */
export function parseExecution(input: ParseExecutionInput): ParsedExecution {
  const dir = resolve(input.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new EvidenceParseError(`실행 폴더가 없다: ${dir}`);
  const outputDir = resolve(input.outputDir ?? join(dir, EXECUTION_LAYOUT.maestro));
  const consolePath = resolve(input.consoleLog ?? join(dir, EXECUTION_LAYOUT.console));
  const junitPath = resolve(input.junit ?? join(dir, EXECUTION_LAYOUT.junit));
  // macOS 도구(sips, Finder 등)는 한글 파일 이름을 NFD 로 쓰기도 한다. commands.json 경로(NFC)와 맞추려고 NFC 로 통일한다.
  const rel = (p: string) => nfc(relative(dir, p).split(sep).join("/"));
  const warnings: string[] = [];

  const consoleText = readText(consolePath);
  const junitText = readText(junitPath);
  const junit = junitText === null ? null : parseJUnit(junitText);
  let exitCode: number | null = input.exitCode ?? null;
  if (input.exitCode === undefined) {
    const raw = readText(join(dir, EXECUTION_LAYOUT.exitCode))?.trim();
    if (raw !== undefined && raw !== "") {
      if (!/^-?\d+$/.test(raw)) throw new EvidenceParseError(`exit-code 형식이 다르다: ${raw}`);
      exitCode = Number(raw);
    }
  }

  const { sessions, flows } = findFlowDirs(outputDir);
  if (flows.length > 1) throw new EvidenceParseError(`실행 하나에 플로우 폴더가 여러 개다(${flows.length}): ${flows.map(rel).join(", ")}`);
  const flowDir = flows[0] ?? null;
  const sessionDir = flowDir ? dirname(flowDir) : (sessions.at(-1) ?? null);

  // 스텝
  const steps: Step[] = [];
  const stepOfArtifact = new Map<string, number>();
  let flowName: string | null = null;
  let appId: string | null = null;
  let manifest: MaestroManifest | null = null;
  let firstTimestamp: number | null = null;
  let lastEnd: number | null = null;
  if (flowDir) {
    const commandsPath = join(flowDir, "commands.json");
    if (!existsSync(commandsPath)) throw new EvidenceParseError(`플로우 폴더에 commands.json 이 없다: ${rel(flowDir)}`);
    const parsed = MaestroCommandsSchema.safeParse(readJson(commandsPath, "commands.json"));
    if (!parsed.success) throw new EvidenceParseError(`commands.json 형식이 다르다(${rel(commandsPath)}): ${parsed.error.message}`);
    const manifestPath = join(flowDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const m = MaestroManifestSchema.safeParse(readJson(manifestPath, "manifest.json"));
      if (!m.success) throw new EvidenceParseError(`manifest.json 형식이 다르다(${rel(manifestPath)}): ${m.error.message}`);
      manifest = m.data;
      for (const e of manifest.entries) {
        if (!existsSync(join(flowDir, e.relativePath))) warnings.push(`매니페스트에 있지만 없는 산출물: ${rel(join(flowDir, e.relativePath))}`);
      }
    }
    const entries = [...parsed.data].sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);
    for (const entry of entries) {
      const [name, body] = Object.entries(entry.command)[0] ?? ["", undefined];
      const m = entry.metadata;
      if (typeof m.timestamp === "number") {
        firstTimestamp = firstTimestamp === null ? m.timestamp : Math.min(firstTimestamp, m.timestamp);
        const end = m.timestamp + (m.duration ?? 0);
        lastEnd = lastEnd === null ? end : Math.max(lastEnd, end);
      }
      if (name === "applyConfigurationCommand") {
        const cfg = ApplyConfigurationSchema.safeParse(body);
        if (cfg.success) {
          flowName = cfg.data.config.name ?? null;
          appId = cfg.data.config.appId ?? null;
        }
      }
      if (SETUP_COMMANDS.has(name)) continue;
      const index = steps.length;
      const step: Step = {
        index,
        sequenceNumber: m.sequenceNumber,
        depth: m.depth ?? 0,
        command: name,
        description: describeCommand(name, body),
        status: m.status.toLowerCase() as Step["status"],
        startedAt: typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : null,
        durationMs: typeof m.duration === "number" ? Math.max(0, Math.round(m.duration)) : null,
        error: m.error ? { message: m.error.message, debugMessage: m.error.debugMessage ?? null } : null,
        screenshot: null,
        failureScreenshot: null,
        hierarchy: null,
      };
      for (const a of m.artifacts ?? []) {
        const path = rel(join(flowDir, a.path));
        if (!existsSync(join(flowDir, a.path))) warnings.push(`스텝 ${index}(${name})의 산출물이 없다: ${path}`);
        stepOfArtifact.set(path, index);
        if (a.type === "TAKE_SCREENSHOT") step.screenshot = path;
        else if (a.type === "SCREENSHOT") step.failureScreenshot = path;
        else if (a.type === "SCREEN_HIERARCHY") step.hierarchy = path;
      }
      steps.push(step);
    }
  }

  // 결과
  const junitCase: JUnitCase | null =
    junit?.cases.find((c) => flowName !== null && nfc(c.name) === nfc(flowName)) ?? (junit?.cases.length === 1 ? (junit.cases[0] ?? null) : null);
  if (junit && junit.cases.length > 0 && junitCase === null) warnings.push(`JUnit 에서 플로우 "${flowName ?? "?"}" 결과를 찾지 못했다`);
  const failedStep = [...steps].reverse().find((s) => s.status === "failed") ?? null;
  const unfinished = steps.find((s) => s.status === "running" || s.status === "pending") ?? null;
  const driverFailure = consoleText !== null && isDriverFailure(consoleText);

  let status: ParsedExecution["status"];
  if (!flowDir) status = "error";
  else if (junitCase) status = junitPassed(junitCase) ? "passed" : "failed";
  else if (exitCode !== null) status = exitCode === 0 ? "passed" : "failed";
  else status = failedStep ? "failed" : unfinished ? "error" : "passed";

  if (status === "passed" && failedStep) warnings.push(`결과는 통과인데 실패한 스텝이 있다: ${failedStep.index}(${failedStep.description})`);
  if (exitCode !== null && flowDir && (exitCode === 0) !== (status === "passed")) warnings.push(`종료 코드 ${exitCode} 와 결과(${status})가 다르다`);

  let failure: Failure | null = null;
  if (status !== "passed") {
    const consoleMessage = consoleText === null ? null : exceptionMessage(consoleText);
    if (!flowDir) {
      if (driverFailure) failure = { kind: "driver_start", message: consoleMessage ?? "Maestro 드라이버를 시작하지 못했다", stepIndex: null };
      else if (consoleMessage) failure = { kind: "flow_error", message: consoleMessage, stepIndex: null };
      else failure = { kind: "no_result", message: "Maestro 산출물이 없다(플로우 폴더 없음)", stepIndex: null };
    } else if (failedStep) {
      failure = { kind: "step_failed", message: failedStep.error?.message ?? junitCase?.failure ?? "스텝 실패", stepIndex: failedStep.index };
    } else if (unfinished) {
      failure = { kind: "interrupted", message: `실행이 끝나지 않았다: ${unfinished.description} (${unfinished.status})`, stepIndex: unfinished.index };
    } else {
      failure = { kind: "flow_error", message: junitCase?.failure ?? consoleMessage ?? `종료 코드 ${exitCode ?? "?"}`, stepIndex: null };
    }
  }

  // 산출물
  const files = listFiles(dir);
  const flowRel = flowDir ? rel(flowDir) : null;
  const classify = (abs: string): ArtifactKind => {
    if (abs === consolePath) return "console_log";
    if (abs === junitPath) return "junit";
    const name = basename(abs);
    if (flowRel !== null && rel(abs).startsWith(`${flowRel}/`)) {
      const inFlow = rel(abs).slice(flowRel.length + 1);
      if (inFlow === "commands.json") return "command_metadata";
      if (inFlow === "manifest.json") return "manifest";
      if (inFlow === "logs/maestro.log") return "maestro_log";
      if (inFlow.startsWith("logs/device-")) return "device_log";
      if (inFlow.startsWith("takeScreenshot/")) return "take_screenshot";
      if (inFlow.startsWith("screenshots/")) return "failure_screenshot";
      if (inFlow.startsWith("screen-hierarchy/")) return "screen_hierarchy";
      return "other";
    }
    if (/^xctest_runner_.*\.log$/.test(name)) return "runner_log";
    return "other";
  };
  const artifacts: Artifact[] = files.map((abs) => {
    const path = rel(abs);
    return {
      kind: classify(abs),
      path,
      bytes: statSync(abs).size,
      stepIndex: stepOfArtifact.get(path) ?? null,
      image: abs.toLowerCase().endsWith(".png") ? pngSize(headBytes(abs, 24)) : null,
    };
  });

  const durationMs =
    junitCase?.timeSeconds != null
      ? Math.round(junitCase.timeSeconds * 1000)
      : firstTimestamp !== null && lastEnd !== null
        ? Math.max(0, Math.round(lastEnd - firstTimestamp))
        : null;

  return ParsedExecutionSchema.parse({
    status,
    failureClass: driverFailure ? "env_issue" : null,
    flowName,
    appId,
    platform: platformOf(manifest, junit, artifacts.some((a) => a.kind === "runner_log")),
    device: junit?.device ?? null,
    sessionDir: sessionDir ? rel(sessionDir) : null,
    flowDir: flowRel,
    startedAt: firstTimestamp === null ? null : new Date(firstTimestamp).toISOString(),
    durationMs,
    exitCode,
    steps,
    failure,
    artifacts,
    warnings,
  });
}
