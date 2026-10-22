import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MaestroCommandsSchema } from "./maestro-schema";
import { EvidenceParseError } from "./model";
import { listFiles } from "./walk";

/**
 * 증적 가림(PLAN 9.1, 9.3; scripts/poc/redact.py 이식).
 * 원본(raw)은 그대로 두고 가린 사본(redacted)을 만든다. 화면 표시와 요약 묶음은 사본으로만 만든다.
 * 이 모듈의 결과와 오류 메시지에는 비밀 값을 넣지 않는다(경로와 개수만).
 */

export const MASK = "***";
/** 이보다 짧은 비밀 값은 일반 문자열과 겹쳐 가릴 수 없다. 업로드 게이트(T-114)는 이런 값이 있으면 막는다 */
export const MIN_SECRET_LENGTH = 3;
/** 플로우 변수(-e, env:)에서 자동으로 모은 값은 이 길이 이상일 때만 모든 파일에서 가린다. 짧은 일반 값("ko" 등)이 로그를 망가뜨리지 않게 한다 */
export const MIN_FLOW_ENV_LENGTH = 6;
/** Maestro 가 스스로 넣는 변수. 비밀이 아니다 */
const MAESTRO_ENV_PREFIX = "MAESTRO_";

const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".zip", ".gz"]);

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 비밀 값 하나가 산출물에 나타날 수 있는 표기들 */
export function secretVariants(secret: string): string[] {
  const variants = new Set<string>();
  // 한글 등은 NFC·NFD 두 정규화로 나타날 수 있다(macOS 파일 이름은 NFD 인 경우가 있다).
  for (const form of new Set([secret, secret.normalize("NFC"), secret.normalize("NFD")])) {
    variants.add(form);
    variants.add(JSON.stringify(form).slice(1, -1)); // commands.json, 화면 트리(JSON 문자열 안)
    variants.add(xmlEscape(form)); // junit.xml
    variants.add(encodeURIComponent(form)); // URL·쿼리 문자열
    variants.add(form.replace(/ /g, "_")); // Maestro 실패 산출물 파일 이름(공백 → _)
  }
  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/** 값 목록 없이 모양으로 가리는 규칙. 서버가 준 토큰처럼 미리 알 수 없는 값을 막는다 */
const PATTERN_RULES: { name: string; re: RegExp; replace: string }[] = [
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replace: MASK },
  { name: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/g, replace: `$1 ${MASK}` },
  {
    name: "json-secret-field",
    re: /("(?:access_?token|refresh_?token|id_?token|password|passwd|secret|api_?key)"\s*:\s*")(?:[^"\\]|\\.)+(")/gi,
    replace: `$1${MASK}$2`,
  },
];

export interface SecretSet {
  /** 모든 파일·경로에서 가릴 표기(긴 것부터) */
  variants: string[];
  /** MIN_SECRET_LENGTH 보다 짧아 가리지 못한 비밀 개수 */
  unredactable: number;
}

export function buildSecretSet(secrets: readonly string[]): SecretSet {
  const variants = new Set<string>();
  let unredactable = 0;
  for (const s of secrets) {
    if (s.length < MIN_SECRET_LENGTH) {
      if (s.length > 0) unredactable += 1;
      continue;
    }
    for (const v of secretVariants(s)) variants.add(v);
  }
  return { variants: [...variants].sort((a, b) => b.length - a.length), unredactable };
}

export interface TextRedaction {
  text: string;
  /** 값 목록으로 바꾼 횟수 */
  values: number;
  /** 모양 규칙별로 바꾼 횟수 */
  patterns: Record<string, number>;
}

export function redactText(text: string, set: SecretSet, options: { patterns?: boolean } = {}): TextRedaction {
  let out = text;
  let values = 0;
  for (const v of set.variants) {
    const parts = out.split(v);
    if (parts.length > 1) {
      values += parts.length - 1;
      out = parts.join(MASK);
    }
  }
  const patterns: Record<string, number> = {};
  if (options.patterns ?? true) {
    for (const rule of PATTERN_RULES) {
      let n = 0;
      out = out.replace(rule.re, (...args: unknown[]) => {
        n += 1;
        const groups = args.slice(1, -2).map((g) => (typeof g === "string" ? g : ""));
        return rule.replace.replace(/\$(\d)/g, (_m, i: string) => groups[Number(i) - 1] ?? "");
      });
      if (n > 0) patterns[rule.name] = n;
    }
  }
  return { text: out, values, patterns };
}

/** commands.json 의 defineVariablesCommand.env 에서 Maestro 자체 변수를 뺀 값 */
export function flowEnvValues(commandsJson: unknown): string[] {
  const parsed = MaestroCommandsSchema.safeParse(commandsJson);
  if (!parsed.success) throw new EvidenceParseError(`commands.json 형식이 다르다: ${parsed.error.message}`);
  const values: string[] = [];
  for (const entry of parsed.data) {
    const body = entry.command["defineVariablesCommand"];
    if (typeof body !== "object" || body === null) continue;
    const env = (body as { env?: unknown }).env;
    if (typeof env !== "object" || env === null) continue;
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (!key.startsWith(MAESTRO_ENV_PREFIX) && typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  return values;
}

/** commands.json 안의 defineVariablesCommand.env 값(Maestro 자체 변수 제외)을 길이와 상관없이 모두 가린다 */
function maskFlowEnv(commandsJson: unknown): unknown {
  if (!Array.isArray(commandsJson)) return commandsJson;
  const maskEnv = (holder: unknown) => {
    if (typeof holder !== "object" || holder === null) return;
    const body = (holder as Record<string, unknown>)["defineVariablesCommand"];
    if (typeof body !== "object" || body === null) return;
    const env = (body as Record<string, unknown>)["env"];
    if (typeof env !== "object" || env === null) return;
    for (const key of Object.keys(env)) {
      if (!key.startsWith(MAESTRO_ENV_PREFIX)) (env as Record<string, unknown>)[key] = MASK;
    }
  };
  for (const entry of commandsJson as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    maskEnv(e["command"]);
    const meta = e["metadata"];
    if (typeof meta === "object" && meta !== null) maskEnv((meta as Record<string, unknown>)["evaluatedCommand"]);
  }
  return commandsJson;
}

function parseJsonFile(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EvidenceParseError(`JSON 을 읽지 못했다(${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isTextFile(path: string, content: Buffer): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot > lower.lastIndexOf("/") && BINARY_EXTENSIONS.has(lower.slice(dot))) return false;
  return !content.subarray(0, 8192).includes(0);
}

export interface RedactDirectoryOptions {
  /** 가릴 비밀 값(키체인의 계정 값, 토큰, -e 로 넘긴 값) */
  secrets: readonly string[];
  /** commands.json 의 플로우 변수 값도 모든 파일에서 가린다(기본 true) */
  includeFlowEnv?: boolean;
}

export interface RedactionReport {
  files: number;
  textFiles: number;
  /** 내용을 바꾼 파일 수 */
  changedFiles: number;
  valueReplacements: number;
  patternReplacements: Record<string, number>;
  /** 이름에 비밀 값이 있어 바꾼 경로 수 */
  renamedPaths: number;
  /** 너무 짧아 가리지 못한 비밀 개수. 0 이 아니면 업로드하면 안 된다 */
  unredactableSecrets: number;
}

/**
 * 원본 폴더를 가린 사본으로 복사한다. 원본은 바꾸지 않는다.
 * - 텍스트 파일: 비밀 값(여러 표기)과 모양 규칙으로 가린다. commands.json 의 플로우 변수 값은 구조로 가린다.
 * - 바이너리(캡처·영상): 그대로 복사한다. 화면 속 개인정보 가림은 M2(T-202).
 * - 경로: 파일·폴더 이름에 비밀 값이 있으면 이름도 가린다.
 */
export function redactExecutionDir(rawDir: string, outDir: string, options: RedactDirectoryOptions): RedactionReport {
  const raw = resolve(rawDir);
  const out = resolve(outDir);
  if (out === raw || out.startsWith(`${raw}${sep}`) || raw.startsWith(`${out}${sep}`)) throw new EvidenceParseError("원본과 사본 폴더는 서로 겹칠 수 없다");
  if (existsSync(out) && readdirSync(out).length > 0) throw new EvidenceParseError(`사본 폴더가 비어 있지 않다: ${out}`);
  const files = listFiles(raw);

  const secrets = [...options.secrets];
  if (options.includeFlowEnv ?? true) {
    for (const f of files.filter((p) => basename(p) === "commands.json")) {
      for (const v of flowEnvValues(parseJsonFile(f, readFileSync(f, "utf8")))) {
        if (v.length >= MIN_FLOW_ENV_LENGTH) secrets.push(v);
      }
    }
  }
  const set = buildSecretSet(secrets);

  const report: RedactionReport = {
    files: files.length,
    textFiles: 0,
    changedFiles: 0,
    valueReplacements: 0,
    patternReplacements: {},
    renamedPaths: 0,
    unredactableSecrets: set.unredactable,
  };
  const written = new Set<string>();
  mkdirSync(out, { recursive: true, mode: 0o700 });

  for (const file of files) {
    const relParts = relative(raw, file).split(sep);
    const safeParts = relParts.map((part) => redactText(part, set, { patterns: false }).text);
    if (safeParts.join("/") !== relParts.join("/")) report.renamedPaths += 1;
    const dest = join(out, ...safeParts);
    if (written.has(dest)) throw new EvidenceParseError(`가린 뒤 경로가 겹친다: ${safeParts.join("/")}`);
    written.add(dest);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });

    const content = readFileSync(file);
    if (!isTextFile(file, content)) {
      copyFileSync(file, dest);
      chmodSync(dest, 0o600);
      continue;
    }
    report.textFiles += 1;
    let text = content.toString("utf8");
    if (basename(file) === "commands.json") {
      // 플로우 변수 값을 구조로 가리고 2칸 들여쓰기로 다시 쓴다. 다른 명령에 들어간 값은 아래 값 가림이 처리한다.
      text = JSON.stringify(maskFlowEnv(parseJsonFile(file, text)), null, 2);
    }
    const r = redactText(text, set);
    report.valueReplacements += r.values;
    for (const [k, n] of Object.entries(r.patterns)) report.patternReplacements[k] = (report.patternReplacements[k] ?? 0) + n;
    if (r.text !== content.toString("utf8")) report.changedFiles += 1;
    writeFileSync(dest, r.text, { mode: 0o600 });
  }
  return report;
}

export interface Residue {
  path: string;
  /** 내용에서 찾은 횟수 */
  occurrences: number;
  /** 경로 이름에서 찾았는지 */
  inPath: boolean;
  /** 모양 규칙(JWT 등)에 걸린 횟수 */
  patternMatches: number;
}

/**
 * 폴더 안에 비밀 값이 남았는지 검사한다(PLAN 9.3 의 2). 값은 돌려주지 않고 경로와 개수만 돌려준다.
 * 바이너리 파일도 바이트로 검사한다.
 */
export function findSecretResidue(dir: string, secrets: readonly string[]): Residue[] {
  const root = resolve(dir);
  return findResidueInFiles(
    listFiles(root).map((file) => ({ path: relative(root, file).split(sep).join("/"), content: readFileSync(file) })),
    secrets,
  );
}

/** 메모리에 있는 파일 목록(요약 묶음)에서 같은 검사를 한다. 업로드 직전 마지막 관문(PLAN 9.3) */
export function findResidueInFiles(files: readonly { path: string; content: Buffer }[], secrets: readonly string[]): Residue[] {
  const set = buildSecretSet(secrets);
  const needles = set.variants.map((v) => Buffer.from(v, "utf8"));
  const result: Residue[] = [];
  for (const { path, content } of files) {
    let occurrences = 0;
    for (const n of needles) {
      for (let at = content.indexOf(n); at !== -1; at = content.indexOf(n, at + n.length)) occurrences += 1;
    }
    const inPath = set.variants.some((v) => path.includes(v));
    let patternMatches = 0;
    if (isTextFile(path, content)) {
      const text = content.toString("utf8");
      for (const rule of PATTERN_RULES) {
        for (const m of text.matchAll(rule.re)) if (!m[0].includes(MASK)) patternMatches += 1;
      }
    }
    if (occurrences > 0 || inPath || patternMatches > 0) result.push({ path, occurrences, inPath, patternMatches });
  }
  return result;
}
