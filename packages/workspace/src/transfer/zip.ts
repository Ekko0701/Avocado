import { crc32, inflateRawSync } from "node:zlib";
import type { ArchiveProblem } from "@qa/shared";
import { entryProblems, MAX_ARCHIVE_TOTAL_BYTES, MAX_ENTRY_BYTES, problem, sizeMessage, totalMessage, type ArchiveEntry, type ArchiveRead } from "./archive";

/** zip 파일 자체의 상한. 읽기 전에 본다(풀린 크기 상한 + 목록·머리 여유) */
export const MAX_ZIP_FILE_BYTES = MAX_ARCHIVE_TOTAL_BYTES + 4 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATE = 8;
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/**
 * 항목의 종류. Unix 에서 만든 zip 은 외부 속성 위 16비트가 파일 모드다(심볼릭 링크는 S_IFLNK).
 * 디렉터리 항목(이름이 / 로 끝남)은 "file" 이면 받을 수 있는 디렉터리라는 뜻이다. MS-DOS 속성 0x10 은 디렉터리다
 */
function entryType(madeBy: number, external: number, directory: boolean): ArchiveEntry["type"] {
  const fileType = madeBy === UNIX ? (external >>> 16) & S_IFMT : 0;
  if (fileType === S_IFLNK) return "link";
  if (directory) return fileType === 0 || fileType === S_IFDIR ? "file" : "other";
  return (fileType === 0 || fileType === S_IFREG) && (external & 0x10) === 0 ? "file" : "other";
}

interface CentralEntry {
  name: string;
  nameBytes: Uint8Array;
  directory: boolean;
  type: ArchiveEntry["type"];
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/**
 * zip 을 풀지 않고 메모리에서 읽는다(ADR 0036 결정 11). unzip 은 링크를 만들고 대소문자만 다른 이름으로 덮어쓰고 작은 zip 을 아주 크게 푼다.
 * 중앙 디렉터리로 목록을 먼저 보고, 하나라도 걸리면 아무것도 풀지 않고 전체를 거절한다. 통과한 항목은 1MB 상한을 걸고 푼다
 * (상한을 넘으면 그 크기를 다 만들기 전에 멈춘다). 받는 것은 저장(0)과 deflate(8)뿐이다.
 */
export function readZip(bytes: Uint8Array): ArchiveRead {
  const format = (message: string): ArchiveRead => ({ ok: false, problems: [problem("", "format", message)] });
  if (bytes.byteLength > MAX_ZIP_FILE_BYTES) return { ok: false, problems: [problem("", "size", "zip 파일이 너무 큽니다")] };
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => buf.readUInt16LE(at);
  const u32 = (at: number) => buf.readUInt32LE(at);

  let eocd = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at -= 1) {
    if (u32(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return format("zip 파일이 아닙니다(끝 레코드가 없습니다)");
  const [disk, cdDisk, onDisk, total, cdSize, cdOffset] = [u16(eocd + 4), u16(eocd + 6), u16(eocd + 8), u16(eocd + 10), u32(eocd + 12), u32(eocd + 16)];
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return format("zip64 형식은 받지 않습니다");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return format("여러 조각으로 나눈 zip 은 받지 않습니다");
  if (cdOffset + cdSize > eocd) return format("중앙 디렉터리가 파일 밖을 가리킵니다");

  const entries: CentralEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (at + 46 > cdOffset + cdSize || u32(at) !== CENTRAL) return format("중앙 디렉터리 형식이 맞지 않습니다");
    const madeBy = u16(at + 4) >> 8;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const external = u32(at + 38);
    const localOffset = u32(at + 42);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > cdOffset + cdSize) return format("중앙 디렉터리 형식이 맞지 않습니다");
    const nameBytes = buf.subarray(at + 46, at + 46 + nameLength);
    // 화면에 보일 이름. ASCII 가 아닌 이름은 어차피 거절하므로 읽을 수 있게만 바꾼다
    const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    const directory = name.endsWith("/");
    entries.push({ name, nameBytes, directory, type: entryType(madeBy, external, directory), flags, method, crc, compressedSize, size, localOffset });
    at = end;
  }
  if (at !== cdOffset + cdSize) return format("중앙 디렉터리 크기가 맞지 않습니다");

  const files = entries.filter((e) => !e.directory);
  const problems: ArchiveProblem[] = entryProblems(
    files.map((e) => ({ path: e.name, type: e.type, size: e.size })),
    entries.filter((e) => e.directory).map((e) => e.name.slice(0, -1)),
  );
  for (const e of entries) {
    // 0x01: 암호, 0x40: 강한 암호
    if ((e.flags & 0x41) !== 0) problems.push(problem(e.name, "encrypted", "암호를 건 항목입니다"));
    if (e.directory) {
      if (e.type === "link") problems.push(problem(e.name, "link", "심볼릭 링크입니다. 일반 파일만 받습니다"));
      else if (e.size !== 0 || e.type === "other") problems.push(problem(e.name, "type", "일반 디렉터리가 아닙니다"));
      continue;
    }
    if (e.method !== STORED && e.method !== DEFLATE) problems.push(problem(e.name, "method", `지원하지 않는 압축 방식(${e.method})입니다`));
  }
  if (problems.length > 0) return { ok: false, problems };

  const out = new Map<string, Uint8Array>();
  let read = 0;
  for (const e of files) {
    const local = e.localOffset;
    if (local + 30 > cdOffset || u32(local) !== LOCAL) return format(`${e.name}: 파일 머리를 찾지 못했습니다`);
    if ((u16(local + 6) & 0x41) !== 0) return { ok: false, problems: [problem(e.name, "encrypted", "암호를 건 항목입니다")] };
    if (u16(local + 8) !== e.method) return format(`${e.name}: 앞뒤 압축 방식이 다릅니다`);
    const nameLength = u16(local + 26);
    const start = local + 30 + nameLength + u16(local + 28);
    if (!Buffer.from(e.nameBytes).equals(buf.subarray(local + 30, local + 30 + nameLength))) return format(`${e.name}: 앞뒤 이름이 다릅니다`);
    const end = start + e.compressedSize;
    if (end > cdOffset) return format(`${e.name}: 내용이 파일 밖을 가리킵니다`);
    const data = buf.subarray(start, end);
    let content: Buffer;
    if (e.method === STORED) {
      if (e.compressedSize !== e.size) return format(`${e.name}: 저장 항목의 크기가 맞지 않습니다`);
      content = Buffer.from(data);
    } else {
      try {
        content = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (error) {
        if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") return { ok: false, problems: [problem(e.name, "size", sizeMessage)] };
        return format(`${e.name}: 압축을 풀지 못했습니다`);
      }
    }
    if (content.length !== e.size) return format(`${e.name}: 푼 크기가 목록과 다릅니다`);
    if (crc32(content) !== e.crc) return format(`${e.name}: CRC 가 맞지 않습니다`);
    read += content.length;
    if (read > MAX_ARCHIVE_TOTAL_BYTES) return { ok: false, problems: [problem("", "size", totalMessage)] };
    out.set(e.name, new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  }
  return { ok: true, files: out };
}
