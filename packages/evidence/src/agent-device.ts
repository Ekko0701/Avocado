import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EvidenceParseError, ParsedExecutionSchema, type Artifact, type ArtifactKind, type Failure, type ParsedExecution, type Step } from "./model";
import { pngSize } from "./png";
import { listFiles } from "./walk";

/**
 * agent-device(iOS 실기기 재생 엔진, ADR 0034) 실행 하나의 증적 폴더.
 * <dir>/agent-device/<실행 해시>/<플로우>/attempt-1/ 아래에 agent-device test --artifacts-dir 산출물이 있다.
 */
export const AGENT_DEVICE_LAYOUT = {
  console: "console.log",
  exitCode: "exit-code",
  /** agent-device test --artifacts-dir */
  artifacts: "agent-device",
  /** 실패 직후 devicectl 로 찍은 화면 */
  failureScreenshot: "failure.png",
} as const;

const TimingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("replay_test_attempt_start"), ts: z.iso.datetime() }).passthrough(),
  z.object({ type: z.literal("replay_test_attempt_stop"), ts: z.iso.datetime(), ok: z.boolean(), timedOut: z.boolean().optional(), durationMs: z.number().int().nonnegative(), errorCode: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("replay_action_start"), ts: z.iso.datetime(), step: z.number().int().positive(), line: z.number().int().positive().optional(), command: z.string(), positionals: z.array(z.string()).default([]) }).passthrough(),
  z.object({ type: z.literal("replay_action_stop"), ts: z.iso.datetime(), step: z.number().int().positive(), command: z.string(), ok: z.boolean(), durationMs: z.number().int().nonnegative(), errorCode: z.string().optional() }).passthrough(),
]);
type TimingEvent = z.infer<typeof TimingEventSchema>;
/** 마무리 단계 같은 다른 이벤트는 건너뛴다 */
const KNOWN_TYPES = new Set(["replay_test_attempt_start", "replay_test_attempt_stop", "replay_action_start", "replay_action_stop"]);

/** 러너·기기 연결 문제로 플로우를 시작하지 못한 실패. 앱의 결함이 아니라 환경 문제다 */
const ENV_FAILURE = /runner|DevToolsSecurity|Developer mode is disabled|provisioning|CoreDeviceError|device is locked|unlock/i;

const nfc = (s: string) => s.normalize("NFC");

function head(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

/** result.txt·failure.txt 의 "키: 값" 줄 */
export function parseKeyValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z]+):\s?(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

function attemptDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return listFiles(root)
    .filter((f) => basename(f) === "result.txt" && /^attempt-\d+$/.test(basename(dirname(f))))
    .map((f) => dirname(f))
    .sort();
}

function readEvents(path: string): TimingEvent[] {
  const events: TimingEvent[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new EvidenceParseError(`replay-timing.ndjson ${i + 1}번 줄이 JSON 이 아니다`);
    }
    const type = typeof value === "object" && value !== null && "type" in value ? (value as { type: unknown }).type : null;
    if (typeof type !== "string" || !KNOWN_TYPES.has(type)) continue;
    const parsed = TimingEventSchema.safeParse(value);
    if (!parsed.success) throw new EvidenceParseError(`replay-timing.ndjson ${i + 1}번 줄 형식이 다르다: ${parsed.error.issues[0]?.message ?? ""}`);
    events.push(parsed.data);
  }
  return events;
}

/** takeScreenshot 이름 → 파일 이름. Maestro 처럼 .png 가 없으면 붙인다 */
function screenshotFile(name: string): string {
  return name.toLowerCase().endsWith(".png") ? name : `${name}.png`;
}

/** agent-device 메시지 끝의 "(<플로우 경로>:line N)" 를 뗀다. 실행용 사본의 임시 경로라 사람에게 쓸모가 없다(줄 번호는 스텝으로 안다) */
export function cleanMessage(message: string): string {
  return message.replace(/\s*\((?:\/|[A-Za-z]:\\)[^()]*:line \d+\)\s*$/, "").trim();
}

function describe(command: string, positionals: readonly string[]): string {
  return positionals.length > 0 ? `${command} ${positionals.map((p) => JSON.stringify(p)).join(" ")}` : command;
}

/**
 * agent-device 실행 하나의 산출물을 스텝·산출물·결과로 바꾼다. 형식은 parseExecution(Maestro)과 같다.
 * - 시도 폴더가 없으면 콘솔 출력으로 원인을 적고 error 로 둔다.
 * - 시도 폴더가 여러 개거나 replay-timing.ndjson 이 없거나 형식이 다르면 EvidenceParseError. 빈 스텝으로 통과시키지 않는다.
 * - 화면 트리는 남지 않는다(hierarchy 는 늘 null).
 */
export function parseAgentDeviceExecution(input: { dir: string; exitCode?: number | null }): ParsedExecution {
  const dir = resolve(input.dir);
  const rel = (p: string) => nfc(relative(dir, p).split(sep).join("/"));
  const warnings: string[] = [];
  let exitCode: number | null = input.exitCode ?? null;
  if (input.exitCode === undefined) {
    const path = join(dir, AGENT_DEVICE_LAYOUT.exitCode);
    const raw = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (raw !== "") {
      if (!/^-?\d+$/.test(raw)) throw new EvidenceParseError(`exit-code 형식이 다르다: ${raw}`);
      exitCode = Number(raw);
    }
  }
  const consolePath = join(dir, AGENT_DEVICE_LAYOUT.console);
  const consoleText = existsSync(consolePath) ? readFileSync(consolePath, "utf8") : null;

  const attempts = attemptDirs(join(dir, AGENT_DEVICE_LAYOUT.artifacts));
  if (attempts.length > 1) throw new EvidenceParseError(`실행 하나에 시도 폴더가 여러 개다(${attempts.length}): ${attempts.map(rel).join(", ")}`);
  const attempt = attempts[0] ?? null;

  const steps: Step[] = [];
  const stepOfFile = new Map<string, number>();
  let failure: Failure | null = null;
  let status: ParsedExecution["status"];
  let failureClass: ParsedExecution["failureClass"] = null;
  let startedAt: string | null = null;
  let durationMs: number | null = null;
  let flowName: string | null = null;
  let appId: string | null = null;

  if (!attempt) {
    const tail = consoleText?.trim().split("\n").slice(-5).join("\n") ?? "";
    status = "error";
    failure = { kind: "no_result", message: tail ? `agent-device 가 결과를 남기지 않았다: ${tail.slice(0, 500)}` : "agent-device 가 결과를 남기지 않았다", stepIndex: null };
  } else {
    const timing = join(attempt, "replay-timing.ndjson");
    if (!existsSync(timing)) throw new EvidenceParseError(`replay-timing.ndjson 이 없다: ${rel(attempt)}`);
    const events = readEvents(timing);
    const result = parseKeyValues(readFileSync(join(attempt, "result.txt"), "utf8"));
    const failureText = existsSync(join(attempt, "failure.txt")) ? parseKeyValues(readFileSync(join(attempt, "failure.txt"), "utf8")) : null;
    const flowCopy = readdirSync(attempt).find((n) => /\.ya?ml$/i.test(n));
    if (flowCopy) {
      const text = readFileSync(join(attempt, flowCopy), "utf8");
      flowName = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? null;
      appId = /^appId:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? null;
    }
    const files = new Set(readdirSync(attempt));

    const starts = new Map<number, Extract<TimingEvent, { type: "replay_action_start" }>>();
    const stops = new Map<number, Extract<TimingEvent, { type: "replay_action_stop" }>>();
    let attemptStop: Extract<TimingEvent, { type: "replay_test_attempt_stop" }> | null = null;
    for (const e of events) {
      if (e.type === "replay_test_attempt_start") startedAt = e.ts;
      else if (e.type === "replay_test_attempt_stop") attemptStop = e;
      else if (e.type === "replay_action_start") starts.set(e.step, e);
      else stops.set(e.step, e);
    }
    durationMs = attemptStop?.durationMs ?? null;
    const resultStatus = result.get("status");
    if (resultStatus !== "passed" && resultStatus !== "failed") throw new EvidenceParseError(`result.txt 의 status 가 다르다: ${resultStatus ?? "(없음)"}`);

    for (const step of [...starts.keys()].sort((a, b) => a - b)) {
      const start = starts.get(step);
      if (!start) continue;
      const stop = stops.get(step);
      const index = steps.length;
      let screenshot: string | null = null;
      if (start.command === "takeScreenshot" && start.positionals[0]) {
        const name = screenshotFile(basename(start.positionals[0]));
        if (files.has(name)) {
          screenshot = rel(join(attempt, name));
          stepOfFile.set(screenshot, index);
        } else if (stop?.ok) {
          warnings.push(`캡처 ${name} 를 찾지 못했다(스텝 ${index + 1})`);
        }
      }
      steps.push({
        index,
        sequenceNumber: step - 1,
        depth: 0,
        command: start.command,
        description: describe(start.command, start.positionals),
        status: stop ? (stop.ok ? "completed" : "failed") : attemptStop ? "skipped" : "running",
        startedAt: start.ts,
        durationMs: stop?.durationMs ?? null,
        error: stop && !stop.ok ? { message: cleanMessage(failureText?.get("message") ?? result.get("message") ?? stop.errorCode ?? "실패"), debugMessage: failureText?.get("hint") ?? null } : null,
        screenshot,
        failureScreenshot: null,
        hierarchy: null,
      });
    }

    if (resultStatus === "passed") {
      status = "passed";
      if (exitCode !== null && exitCode !== 0) warnings.push(`결과는 통과인데 agent-device 종료 코드가 ${exitCode} 이다`);
    } else {
      const failed = steps.find((s) => s.status === "failed") ?? null;
      const message = cleanMessage(failureText?.get("message") ?? result.get("message") ?? "agent-device 재생이 실패했다");
      const shot = join(dir, AGENT_DEVICE_LAYOUT.failureScreenshot);
      if (failed && existsSync(shot)) {
        failed.failureScreenshot = rel(shot);
        stepOfFile.set(rel(shot), failed.index);
      }
      if (ENV_FAILURE.test(message)) {
        status = "error";
        failureClass = "env_issue";
        failure = { kind: "driver_start", message, stepIndex: failed?.index ?? null };
      } else if (failed) {
        status = "failed";
        failure = { kind: "step_failed", message, stepIndex: failed.index };
      } else if (steps.some((s) => s.status === "running") || attemptStop?.timedOut) {
        status = "error";
        failure = { kind: "interrupted", message, stepIndex: null };
      } else {
        status = "failed";
        failure = { kind: "flow_error", message, stepIndex: null };
      }
    }
  }

  const artifacts: Artifact[] = listFiles(dir).map((f) => {
    const path = rel(f);
    const name = basename(f);
    let kind: ArtifactKind = "other";
    if (path === AGENT_DEVICE_LAYOUT.console) kind = "console_log";
    else if (path === AGENT_DEVICE_LAYOUT.failureScreenshot) kind = "failure_screenshot";
    else if (name === "replay-timing.ndjson") kind = "command_metadata";
    else if (name === "failure.txt" || (name.endsWith(".ndjson") && attempt !== null && dirname(f) === attempt)) kind = "runner_log";
    else if (stepOfFile.has(path)) kind = "take_screenshot";
    else if (name.toLowerCase().endsWith(".png")) kind = "take_screenshot";
    const bytes = statSync(f).size;
    const image = name.toLowerCase().endsWith(".png") ? pngSize(head(f, 24)) : null;
    return { kind, path, bytes, stepIndex: stepOfFile.get(path) ?? null, image };
  });

  return ParsedExecutionSchema.parse({
    status,
    failureClass,
    flowName,
    appId,
    platform: "ios",
    device: null,
    sessionDir: attempt ? rel(dirname(dirname(attempt))) : null,
    flowDir: attempt ? rel(attempt) : null,
    startedAt,
    durationMs,
    exitCode,
    steps,
    failure,
    artifacts,
    warnings,
  });
}
