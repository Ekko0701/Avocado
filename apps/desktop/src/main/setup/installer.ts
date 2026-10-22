import type { InstallProgress, ToolId, ToolStatus } from "@qa/shared";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CommandRunner } from "./command";
import type { ToolDefinition } from "./tools";

export class ChecksumMismatchError extends Error {
  constructor(tool: ToolId) {
    super(`${tool} 내려받은 파일의 SHA-256 이 고정값과 다르다. 설치하지 않았다`);
    this.name = "ChecksumMismatchError";
  }
}

export class InstallBusyError extends Error {
  constructor() {
    super("다른 도구를 설치하는 중이다");
    this.name = "InstallBusyError";
  }
}

const ManifestSchema = z.strictObject({
  id: z.enum(["jre", "maestro"]),
  version: z.string(),
  sha256: z.string(),
  /** 설치 폴더 기준 상대 경로. jre 는 JAVA_HOME, maestro 는 실행 파일 */
  entry: z.string(),
  installedAt: z.iso.datetime(),
});
type Manifest = z.infer<typeof ManifestSchema>;

const MANIFEST = ".qa-tool.json";

export interface InstallerOptions {
  toolsDir: string;
  tools: Record<ToolId, ToolDefinition>;
  run: CommandRunner;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * 고정 버전 도구를 앱 데이터 폴더(tools/)에 설치한다.
 * 내려받기 → SHA-256 확인 → 임시 폴더에 풀기 → 진입점 확인 → 이름 바꾸기로 한 번에 설치.
 * 어느 단계든 실패하면 임시 파일·폴더를 지우고 기존 설치는 건드리지 않는다.
 */
export class ToolInstaller {
  private busy = false;
  private current: InstallProgress = { tool: null, phase: "idle", receivedBytes: 0, totalBytes: null, message: null };

  constructor(private readonly options: InstallerOptions) {}

  progress(): InstallProgress {
    return this.current;
  }

  installDir(id: ToolId): string {
    const def = this.options.tools[id];
    return join(this.options.toolsDir, `${id}-${def.version}`);
  }

  private manifest(id: ToolId): Manifest | null {
    const path = join(this.installDir(id), MANIFEST);
    if (!existsSync(path)) return null;
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return null;
    const def = this.options.tools[id];
    if (parsed.data.version !== def.version || parsed.data.sha256 !== def.sha256) return null;
    if (!existsSync(join(this.installDir(id), parsed.data.entry))) return null;
    return parsed.data;
  }

  status(id: ToolId): ToolStatus {
    const def = this.options.tools[id];
    const m = this.manifest(id);
    return {
      id,
      version: def.version,
      installed: m !== null,
      path: m ? join(this.installDir(id), m.entry) : null,
      downloadBytes: def.sizeBytes,
    };
  }

  /** 설치된 JRE 의 JAVA_HOME. 없으면 null */
  javaHome(): string | null {
    return this.status("jre").path;
  }

  /** 설치된 maestro 실행 파일. 없으면 null */
  maestroBin(): string | null {
    return this.status("maestro").path;
  }

  async install(id: ToolId): Promise<ToolStatus> {
    if (this.status(id).installed) return this.status(id);
    if (this.busy) throw new InstallBusyError();
    this.busy = true;
    const def = this.options.tools[id];
    const suffix = randomBytes(6).toString("hex");
    mkdirSync(this.options.toolsDir, { recursive: true, mode: 0o700 });
    const download = join(this.options.toolsDir, `.download-${id}-${suffix}`);
    const staging = join(this.options.toolsDir, `.staging-${id}-${suffix}`);
    try {
      this.set({ tool: id, phase: "downloading", receivedBytes: 0, totalBytes: def.sizeBytes, message: null });
      const digest = await this.download(def, download);
      this.set({ ...this.current, phase: "verifying" });
      if (digest !== def.sha256) throw new ChecksumMismatchError(id);

      this.set({ ...this.current, phase: "extracting" });
      mkdirSync(staging, { recursive: true });
      const args =
        def.archive === "tar.gz" ? ["-xzf", download, "-C", staging] : ["-x", "-k", download, staging];
      const tool = def.archive === "tar.gz" ? "/usr/bin/tar" : "/usr/bin/ditto";
      const extracted = await this.options.run(tool, args, { timeoutMs: 300_000 });
      if (extracted.code !== 0) throw new Error(`${id} 압축을 풀지 못했다: ${extracted.stderr.trim()}`);

      const entry = findEntry(id, staging);
      if (!entry) throw new Error(`${id} 압축 안에서 실행 파일을 찾지 못했다`);
      const manifest: Manifest = {
        id,
        version: def.version,
        sha256: def.sha256,
        entry,
        installedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      };
      writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

      const target = this.installDir(id);
      rmSync(target, { recursive: true, force: true }); // 같은 버전의 깨진 설치만 지운다
      renameSync(staging, target);
      this.set({ ...this.current, phase: "done", message: `${id} ${def.version} 설치함` });
      return this.status(id);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      this.set({ ...this.current, phase: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      rmSync(download, { force: true });
      this.busy = false;
    }
  }

  private set(next: InstallProgress): void {
    this.current = next;
  }

  /** 스트리밍으로 받으며 SHA-256 을 계산한다. 고정 크기의 110% + 64KB 를 넘으면 중단한다. */
  private async download(def: ToolDefinition, dest: string): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(def.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`${def.id} 내려받기 실패: HTTP ${response.status}`);
    const limit = Math.ceil(def.sizeBytes * 1.1) + 64 * 1024;
    const hash = createHash("sha256");
    const out = createWriteStream(dest, { mode: 0o600 });
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) {
          await reader.cancel();
          throw new Error(`${def.id} 파일이 예상 크기보다 크다. 내려받기를 중단했다`);
        }
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        this.set({ ...this.current, receivedBytes: received });
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
    return hash.digest("hex");
  }
}

/** 압축 구조에서 진입점을 찾는다. jre: <top>/Contents/Home (bin/java 확인), maestro: maestro/bin/maestro */
function findEntry(id: ToolId, root: string): string | null {
  if (id === "maestro") {
    return existsSync(join(root, "maestro", "bin", "maestro")) ? join("maestro", "bin", "maestro") : null;
  }
  for (const top of readdirSync(root)) {
    const home = join(top, "Contents", "Home");
    if (existsSync(join(root, home, "bin", "java"))) return home;
  }
  return null;
}
