import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildFakeToolArchives,
  fakeToolDefinitions,
  FAKE_MAESTRO_VERSION,
  serveFiles,
  type FakeArchives,
  type FileServer,
} from "../../../test-support/fake-tools";
import { runCommand } from "./command";
import { ChecksumMismatchError, InstallBusyError, ToolInstaller } from "./installer";

let archives: FakeArchives;
let server: FileServer;
let toolsDir: string;

beforeAll(async () => {
  archives = buildFakeToolArchives();
  const big = join(archives.dir, "big.bin");
  writeFileSync(big, randomBytes(2 * 1024 * 1024));
  server = await serveFiles(
    { "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro, "slow.tar.gz": archives.jre, "big.bin": big },
    { delayMs: { "slow.tar.gz": 400 } },
  );
});
afterAll(async () => {
  await server.close();
  rmSync(archives.dir, { recursive: true, force: true });
});
beforeEach(() => {
  toolsDir = mkdtempSync(join(tmpdir(), "qa-tools-"));
  server.requests.length = 0;
});
afterEach(() => {
  rmSync(toolsDir, { recursive: true, force: true });
});

function installer(overrides: Partial<ReturnType<typeof fakeToolDefinitions>["jre"]> = {}) {
  const defs = fakeToolDefinitions(server.url, archives);
  return new ToolInstaller({ toolsDir, tools: { ...defs, jre: { ...defs.jre, ...overrides } }, run: runCommand });
}

function leftovers(): string[] {
  return readdirSync(toolsDir).filter((f) => f.startsWith(".download-") || f.startsWith(".staging-"));
}

describe("ToolInstaller", () => {
  it("내려받고 확인한 뒤 진입점까지 설치한다", async () => {
    const inst = installer();
    expect(inst.status("jre").installed).toBe(false);
    await inst.install("jre");
    await inst.install("maestro");
    expect(inst.javaHome()).toMatch(/fake-jre\/Contents\/Home$/);
    expect(inst.maestroBin()).toMatch(new RegExp(`maestro-${FAKE_MAESTRO_VERSION}/maestro/bin/maestro$`));
    expect(existsSync(join(inst.installDir("jre"), ".qa-tool.json"))).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(inst.progress()).toMatchObject({ tool: "maestro", phase: "done" });
  });

  it("이미 설치돼 있으면 다시 내려받지 않는다", async () => {
    const inst = installer();
    await inst.install("jre");
    await inst.install("jre");
    expect(server.requests.filter((r) => r === "jre.tar.gz")).toHaveLength(1);
  });

  it("체크섬이 다르면 설치하지 않고 임시 파일을 남기지 않는다", async () => {
    const inst = installer({ sha256: "0".repeat(64) });
    await expect(inst.install("jre")).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(inst.installDir("jre"))).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(inst.progress().phase).toBe("error");
  });

  it("예상 크기보다 큰 파일은 중간에 끊는다", async () => {
    const inst = installer({ url: `${server.url}/big.bin`, sizeBytes: 1000 });
    await expect(inst.install("jre")).rejects.toThrow(/예상 크기보다 크다/);
    expect(leftovers()).toEqual([]);
  });

  it("HTTP 오류를 그대로 알린다", async () => {
    const inst = installer({ url: `${server.url}/missing.tar.gz` });
    await expect(inst.install("jre")).rejects.toThrow(/HTTP 404/);
  });

  it("한 번에 하나만 설치한다", async () => {
    const inst = installer({ url: `${server.url}/slow.tar.gz` });
    const first = inst.install("jre");
    await expect(inst.install("maestro")).rejects.toBeInstanceOf(InstallBusyError);
    await first;
  });
});
