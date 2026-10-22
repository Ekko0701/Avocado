import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 테스트용 가짜 JRE·Maestro 묶음과 로컬 HTTP 서버.
 * 가짜 maestro 는 JAVA_HOME 이 없거나 사용자 PATH(/opt/homebrew/bin 등)가 섞이면 실패한다.
 */
export const FAKE_JRE_VERSION = "21-fake";
export const FAKE_MAESTRO_VERSION = "9.9.9-fake";

export interface FakeArchives {
  dir: string;
  jre: string;
  maestro: string;
}

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export function buildFakeToolArchives(): FakeArchives {
  const dir = mkdtempSync(join(tmpdir(), "qa-fake-tools-"));
  const javaBin = join(dir, "src-jre", "fake-jre", "Contents", "Home", "bin");
  mkdirSync(javaBin, { recursive: true });
  writeExecutable(join(javaBin, "java"), `#!/bin/sh\necho 'openjdk version "${FAKE_JRE_VERSION}"'\n`);
  execFileSync("/usr/bin/tar", ["-czf", join(dir, "jre.tar.gz"), "-C", join(dir, "src-jre"), "fake-jre"]);

  const maestroBin = join(dir, "src-maestro", "maestro", "bin");
  mkdirSync(maestroBin, { recursive: true });
  writeExecutable(
    join(maestroBin, "maestro"),
    [
      "#!/bin/sh",
      'if [ -z "$JAVA_HOME" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then echo "JAVA_HOME 없음" >&2; exit 3; fi',
      'case ":$PATH:" in *:/opt/homebrew/bin:*|*:/usr/local/bin:*) echo "사용자 PATH 가 섞였다" >&2; exit 4;; esac',
      `echo "${FAKE_MAESTRO_VERSION}"`,
      "",
    ].join("\n"),
  );
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(dir, "src-maestro", "maestro"), join(dir, "maestro.zip")]);
  return { dir, jre: join(dir, "jre.tar.gz"), maestro: join(dir, "maestro.zip") };
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface FileServer {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/** files: URL 경로 이름 → 파일. delayMs 가 있으면 첫 바이트 전에 기다린다. */
export function serveFiles(files: Record<string, string>, options: { delayMs?: Record<string, number> } = {}): Promise<FileServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const name = (req.url ?? "/").slice(1);
    requests.push(name);
    const path = files[name];
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    const send = () => {
      res.writeHead(200, { "content-length": statSync(path).size, "content-type": "application/octet-stream" });
      createReadStream(path).pipe(res);
    };
    const delay = options.delayMs?.[name];
    if (delay) setTimeout(send, delay);
    else send();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

export function fakeToolDefinitions(baseUrl: string, archives: FakeArchives) {
  return {
    jre: {
      id: "jre" as const,
      version: FAKE_JRE_VERSION,
      url: `${baseUrl}/jre.tar.gz`,
      sha256: sha256(archives.jre),
      sizeBytes: statSync(archives.jre).size,
      archive: "tar.gz" as const,
    },
    maestro: {
      id: "maestro" as const,
      version: FAKE_MAESTRO_VERSION,
      url: `${baseUrl}/maestro.zip`,
      sha256: sha256(archives.maestro),
      sizeBytes: statSync(archives.maestro).size,
      archive: "zip" as const,
    },
  };
}
