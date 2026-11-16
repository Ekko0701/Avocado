import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveProblem } from "@qa/shared";
import { entryProblems, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_TOTAL_BYTES, MAX_ENTRY_BYTES, problem, sizeMessage, totalMessage, type ArchiveEntry, type ArchiveRead } from "./archive";

const MAX_DEPTH = 24;

/**
 * 고른 폴더를 링크를 따라가지 않고 읽는다(ADR 0036 결정 11). lstat 으로 걷고 .git 은 열지 않는다.
 * 이 폴더에서 git 을 실행하지 않는다: 저장소 설정(core.fsmonitor 등)이 명령을 실행하게 할 수 있다.
 * 규칙과 상한은 zip 과 같다. 하나라도 걸리면 아무것도 읽지 않고 전체를 거절한다.
 */
export function readFolder(root: string): ArchiveRead {
  const top = lstatSync(root);
  if (top.isSymbolicLink()) return { ok: false, problems: [problem("", "link", "고른 폴더가 심볼릭 링크입니다")] };
  if (!top.isDirectory()) return { ok: false, problems: [problem("", "type", "폴더가 아닙니다")] };

  const entries: ArchiveEntry[] = [];
  const directories: string[] = [];
  const problems: ArchiveProblem[] = [];
  let visited = 0;
  const walk = (rel: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) {
      problems.push(problem(rel, "path", "폴더가 너무 깊습니다"));
      return false;
    }
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (name === ".git") continue;
      visited += 1;
      if (visited > MAX_ARCHIVE_ENTRIES) {
        problems.push(problem("", "count", `항목이 ${MAX_ARCHIVE_ENTRIES}개를 넘습니다`));
        return false;
      }
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) {
        directories.push(path);
        if (!walk(path, depth + 1)) return false;
      } else entries.push({ path, type: st.isSymbolicLink() ? "link" : st.isFile() ? "file" : "other", size: st.size });
    }
    return true;
  };
  walk("", 0);
  problems.push(...entryProblems(entries, directories));
  if (problems.length > 0) return { ok: false, problems };

  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of entries) {
    const read = readCapped(join(root, entry.path));
    if (read === null) return { ok: false, problems: [problem(entry.path, "size", sizeMessage)] };
    if (read === "changed") return { ok: false, problems: [problem(entry.path, "type", "읽는 사이에 파일이 바뀌었습니다")] };
    total += read.byteLength;
    if (total > MAX_ARCHIVE_TOTAL_BYTES) return { ok: false, problems: [problem("", "size", totalMessage)] };
    files.set(entry.path, read);
  }
  return { ok: true, files };
}

/** 링크를 따라가지 않고 열어 상한까지만 읽는다. 상한을 넘으면 null, 그사이 일반 파일이 아니게 됐거나 크기가 바뀌었으면 "changed" */
function readCapped(path: string): Uint8Array | null | "changed" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ELOOP") return "changed";
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return "changed";
    // 목록을 본 뒤 커졌을 수 있다. 상한보다 한 바이트 더 읽어 보고 넘으면 거절한다
    const buf = Buffer.alloc(Math.min(st.size, MAX_ENTRY_BYTES) + 1);
    let length = 0;
    while (length < buf.length) {
      const n = readSync(fd, buf, length, buf.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > MAX_ENTRY_BYTES) return null;
    if (length !== st.size) return "changed";
    return new Uint8Array(buf.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
