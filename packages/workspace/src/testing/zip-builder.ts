import { crc32, deflateRawSync } from "node:zlib";

/** 시험용 zip 을 바이트로 만든다. 정상 zip 과 함께 이름·종류·크기·방식을 속인 zip 을 만들 수 있다 */
export interface ZipEntrySpec {
  name: string | Uint8Array;
  data?: string | Uint8Array;
  /** 0 저장, 8 deflate. 다른 값은 그대로 적는다(지원하지 않는 방식 시험) */
  method?: number;
  /** Unix 파일 모드(예: 0o120777 심볼릭 링크). 주면 "Unix 에서 만듦"으로 적는다 */
  mode?: number;
  flags?: number;
  /** 목록에 적을 푼 크기(실제와 다르게 속일 때) */
  declaredSize?: number;
  /** 이미 압축한 내용(작은 zip 이 크게 풀리는 시험) */
  compressed?: Uint8Array;
  /** 내용의 CRC 대신 적을 값 */
  crc?: number;
}

const bytes = (v: string | Uint8Array) => (typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v));

export function buildZip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = bytes(e.name);
    const data = bytes(e.data ?? "");
    const method = e.method ?? 8;
    const body = e.compressed ? Buffer.from(e.compressed) : method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const flags = e.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.mode === undefined ? 0 : (e.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
