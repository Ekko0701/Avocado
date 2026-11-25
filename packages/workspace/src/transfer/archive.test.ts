import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip } from "../testing/zip-builder";
import { MAX_ARCHIVE_ENTRIES, MAX_ENTRY_BYTES, type ArchiveRead } from "./archive";
import { readFolder } from "./folder";
import { readZip } from "./zip";

const EXAMPLE = resolve(__dirname, "../../../../examples/qa-workspace");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-archive-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const codes = (r: ArchiveRead) => (r.ok ? [] : r.problems.map((p) => `${p.code}:${p.path}`));
const text = (r: ArchiveRead, path: string) => (r.ok ? Buffer.from(r.files.get(path) ?? []).toString("utf8") : null);

describe("zip 을 풀지 않고 읽기", () => {
  it("git archive 로 만든 zip 의 파일을 모두 같은 바이트로 읽는다(디렉터리 항목은 뺀다)", () => {
    const repo = join(dir, "repo");
    cpSync(EXAMPLE, repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=T", "-c", "user.email=t@example.test", ...args], { cwd: repo, env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "seed");
    const zip = join(dir, "export.zip");
    git("archive", "--format=zip", `--output=${zip}`, "HEAD", "--", "workspace.yaml", "apps");
    const read = readZip(readFileSync(zip));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const tracked = git("ls-files", "workspace.yaml", "apps").toString().trim().split("\n").sort();
    expect([...read.files.keys()].sort()).toEqual(tracked);
    for (const path of tracked) expect(Buffer.from(read.files.get(path) ?? []).equals(readFileSync(join(repo, path)))).toBe(true);
  });

  it("저장(0)과 deflate(8) 항목을 읽는다", () => {
    const read = readZip(buildZip([{ name: "a.txt", data: "stored", method: 0 }, { name: "b/", method: 0 }, { name: "b/c.txt", data: "deflated" }]));
    expect(codes(read)).toEqual([]);
    expect(text(read, "a.txt")).toBe("stored");
    expect(text(read, "b/c.txt")).toBe("deflated");
    expect(read.ok && read.files.has("b/")).toBe(false);
  });

  const rejects = (name: string, entries: Parameters<typeof buildZip>[0], expected: RegExp) =>
    it(name, () => {
      const read = readZip(buildZip(entries));
      expect(read.ok).toBe(false);
      expect(codes(read).join(" ")).toMatch(expected);
    });

  rejects("심볼릭 링크 항목", [{ name: "workspace.yaml", data: "x" }, { name: "apps/demo/app.yaml", data: "/etc/passwd", method: 0, mode: 0o120777 }], /link:apps\/demo\/app\.yaml/);
  rejects("디렉터리로 표시한 링크", [{ name: "apps/", method: 0, mode: 0o120777 }], /link:apps\//);
  rejects("장치 파일 같은 일반 파일이 아닌 항목", [{ name: "apps/x", data: "", method: 0, mode: 0o020644 }], /type:apps\/x/);
  rejects("../ 로 밖을 가리키는 이름", [{ name: "apps/demo/../../escape.txt", data: "x" }], /path:apps\/demo\/\.\.\/\.\.\/escape\.txt/);
  rejects("절대 경로", [{ name: "/etc/x", data: "x" }], /path:\/etc\/x/);
  rejects("역슬래시", [{ name: "apps\\demo\\app.yaml", data: "x" }], /path:apps\\demo\\app\.yaml/);
  rejects("드라이브로 시작하는 이름", [{ name: "C:/x.txt", data: "x" }], /path:C:\/x\.txt/);
  rejects("ASCII 가 아닌 이름", [{ name: "apps/demo/메모.md", data: "x" }], /name:apps\/demo\/메모\.md/);
  rejects("대소문자만 다른 두 이름", [{ name: "apps/demo/testcases/TC-0002.md", data: "a" }, { name: "Apps/Demo/testcases/TC-0002.md", data: "b" }], /collision:Apps\/Demo\/testcases\/TC-0002\.md/);
  rejects("NFC 와 NFD 로만 다른 두 이름", [{ name: "apps/caf\u00e9.md", data: "a" }, { name: "apps/cafe\u0301.md", data: "b" }], /collision:apps\/cafe\u0301\.md/);
  rejects("같은 이름 두 번", [{ name: "a.txt", data: "a" }, { name: "a.txt", data: "b" }], /collision:a\.txt/);
  rejects("암호를 건 항목", [{ name: "a.txt", data: "x", flags: 0x1 }], /encrypted:a\.txt/);
  rejects("지원하지 않는 압축 방식(12, bzip2)", [{ name: "a.txt", data: "x", method: 12, compressed: Buffer.from("BZh") }], /method:a\.txt/);
  rejects("목록의 크기가 1MB 를 넘는 항목", [{ name: "big.txt", data: "x", declaredSize: MAX_ENTRY_BYTES + 1 }], /size:big\.txt/);

  it(`항목이 ${MAX_ARCHIVE_ENTRIES}개를 넘으면 목록만 보고 거절한다`, () => {
    const read = readZip(buildZip(Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt`, data: "", method: 0 }))));
    expect(codes(read)).toEqual(["count:"]);
  });

  it("모두 풀면 20MB 를 넘는다고 적힌 zip 은 목록만 보고 거절한다", () => {
    const read = readZip(buildZip(Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, data: "x", declaredSize: MAX_ENTRY_BYTES }))));
    expect(read.ok ? [] : read.problems.map((p) => p.message)).toEqual(["모두 풀면 20MB 를 넘습니다(전체 상한)"]);
  });

  it("작은 deflate 가 1MB 넘게 풀리면 다 풀지 않고 거절한다(목록의 크기를 작게 속여도)", () => {
    const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 0x41), { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    const before = process.memoryUsage().arrayBuffers;
    const read = readZip(buildZip([{ name: "apps/demo/flows/ios/TC-0001.yaml", compressed: bomb, declaredSize: 10, crc: 0 }]));
    expect(codes(read)).toEqual(["size:apps/demo/flows/ios/TC-0001.yaml"]);
    // 64MB 를 만들지 않았다(상한 1MB 만큼만 잡았다가 버린다)
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it("CRC 나 푼 크기가 목록과 다르면 거절한다", () => {
    expect(codes(readZip(buildZip([{ name: "a.txt", data: "hello", crc: 1 }])))).toEqual(["format:"]);
    expect(codes(readZip(buildZip([{ name: "a.txt", data: "hello", declaredSize: 3 }])))).toEqual(["format:"]);
  });

  it("zip 이 아니면 형식 문제로 거절한다", () => {
    expect(codes(readZip(Buffer.from("not a zip at all, just text")))).toEqual(["format:"]);
  });

  it("여러 문제를 한꺼번에 알린다", () => {
    const read = readZip(buildZip([{ name: "apps/demo/app.yaml", data: "x", method: 0, mode: 0o120777 }, { name: "../x", data: "x" }, { name: "a.txt", data: "x", flags: 1 }]));
    expect(codes(read)).toEqual(expect.arrayContaining(["link:apps/demo/app.yaml", "path:../x", "encrypted:a.txt"]));
  });
});

describe("폴더를 링크 없이 읽기", () => {
  const folder = (name: string) => {
    const root = join(dir, name);
    mkdirSync(join(root, "apps", "demo"), { recursive: true });
    writeFileSync(join(root, "workspace.yaml"), "schemaVersion: 2\nname: x\napps: [demo]\n");
    writeFileSync(join(root, "apps", "demo", "app.yaml"), "name: Demo\n");
    return root;
  };

  it("일반 파일을 읽고 .git 은 열지 않는다", () => {
    const root = folder("plain");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "[core]\n\tfsmonitor = touch marker\n");
    const read = readFolder(root);
    expect(read.ok && [...read.files.keys()].sort()).toEqual(["apps/demo/app.yaml", "workspace.yaml"]);
    expect(existsSync(join(root, "marker"))).toBe(false);
  });

  it("파일 심볼릭 링크를 따라가지 않고 전체를 거절한다", () => {
    const root = folder("file-link");
    writeFileSync(join(dir, "outside.txt"), "secret");
    symlinkSync(join(dir, "outside.txt"), join(root, "apps", "demo", "accounts.yaml"));
    expect(codes(readFolder(root))).toEqual(["link:apps/demo/accounts.yaml"]);
  });

  it("폴더 심볼릭 링크 안으로 들어가지 않는다", () => {
    const root = folder("dir-link");
    mkdirSync(join(dir, "outside-dir"), { recursive: true });
    writeFileSync(join(dir, "outside-dir", "TC-0001.md"), "x");
    symlinkSync(join(dir, "outside-dir"), join(root, "apps", "demo", "testcases"));
    expect(codes(readFolder(root))).toEqual(["link:apps/demo/testcases"]);
  });

  it("고른 폴더 자체가 링크면 거절한다", () => {
    const root = folder("target");
    symlinkSync(root, join(dir, "link-to-target"));
    expect(codes(readFolder(join(dir, "link-to-target")))).toEqual(["link:"]);
  });

  it("1MB 를 넘는 파일과 ASCII 가 아닌 이름을 읽지 않고 거절한다", () => {
    const root = folder("big");
    writeFileSync(join(root, "apps", "demo", "big.yaml"), Buffer.alloc(MAX_ENTRY_BYTES + 1, 0x41));
    writeFileSync(join(root, "apps", "demo", "메모.md"), "x");
    expect(codes(readFolder(root)).sort()).toEqual(["name:apps/demo/메모.md", "size:apps/demo/big.yaml"]);
  });
});
