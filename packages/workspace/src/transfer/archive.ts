import type { ArchiveProblem, ArchiveProblemCode } from "@qa/shared";

/**
 * 가져올 파일 묶음(zip·폴더·로컬 워크스페이스)을 읽는 공통 규칙(ADR 0036 결정 11).
 * 받은 묶음은 남이 만든 것이다. 목록을 먼저 보고 하나라도 걸리면 묶음 전체를 거절한다. 통과한 파일만 상한을 걸고 메모리로 읽는다.
 */
export const MAX_ARCHIVE_ENTRIES = 2000;
export const MAX_ARCHIVE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 400;

export type ArchiveRead = { ok: true; files: Map<string, Uint8Array> } | { ok: false; problems: ArchiveProblem[] };

/** 묶음 안의 항목 하나(읽기 전). 디렉터리는 넣지 않는다 */
export interface ArchiveEntry {
  path: string;
  type: "file" | "link" | "other";
  /** 풀었을 때의 크기(알려 준 값) */
  size: number;
}

export const problem = (path: string, code: ArchiveProblemCode, message: string): ArchiveProblem => ({ path, code, message });

export const sizeMessage = "풀면 1MB 를 넘습니다(파일 하나의 상한)";
export const totalMessage = "모두 풀면 20MB 를 넘습니다(전체 상한)";

/** 이름 하나의 문제. 경로 조각이 워크스페이스 밖을 가리키거나 해석이 OS 마다 다를 수 있는 이름을 막는다 */
function nameProblems(path: string): ArchiveProblem[] {
  const out: ArchiveProblem[] = [];
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(path)) out.push(problem(path, "name", /[^\x00-\x7f]/.test(path) ? "ASCII 가 아닌 이름입니다" : "이름에 제어 문자가 있습니다"));
  if (path.length > MAX_PATH_LENGTH) out.push(problem(path, "name", "이름이 너무 깁니다"));
  if (path.includes("\\")) out.push(problem(path, "path", "역슬래시가 든 이름입니다"));
  if (path.startsWith("/")) out.push(problem(path, "path", "절대 경로입니다"));
  else if (/^[A-Za-z]:/.test(path)) out.push(problem(path, "path", "드라이브로 시작하는 경로입니다"));
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.includes("..")) out.push(problem(path, "path", "워크스페이스 밖을 가리키는 경로입니다"));
  else if (segments.some((s) => s === "." || s === "")) out.push(problem(path, "path", "빈 조각이나 . 이 든 경로입니다"));
  return out;
}

/** APFS 처럼 대소문자와 유니코드 정규화를 가리지 않는 디스크에서 같은 파일이 되는 이름 */
export const foldPath = (path: string): string => path.normalize("NFC").toLowerCase();

/**
 * 항목 목록 전체의 문제: 이름 규칙, 일반 파일이 아닌 항목, 접으면 겹치는 이름, 개수·크기 상한.
 * 디렉터리는 넘기지 않는다(이름 규칙만 따로 본다)
 */
export function entryProblems(entries: readonly ArchiveEntry[], directories: readonly string[] = []): ArchiveProblem[] {
  const out: ArchiveProblem[] = [];
  if (entries.length > MAX_ARCHIVE_ENTRIES) return [problem("", "count", `항목이 ${MAX_ARCHIVE_ENTRIES}개를 넘습니다`)];
  for (const dir of directories) out.push(...nameProblems(dir));
  const seen = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    out.push(...nameProblems(entry.path));
    if (entry.type === "link") out.push(problem(entry.path, "link", "심볼릭 링크입니다. 일반 파일만 받습니다"));
    else if (entry.type === "other") out.push(problem(entry.path, "type", "일반 파일이 아닙니다"));
    if (entry.size > MAX_ENTRY_BYTES) out.push(problem(entry.path, "size", sizeMessage));
    total += entry.size;
    const folded = foldPath(entry.path);
    const other = seen.get(folded);
    if (other !== undefined) out.push(problem(entry.path, "collision", other === entry.path ? "같은 이름이 두 번 있습니다" : `${other} 와 대소문자·정규화만 다릅니다`));
    else seen.set(folded, entry.path);
  }
  if (total > MAX_ARCHIVE_TOTAL_BYTES) out.push(problem("", "size", totalMessage));
  return out;
}
