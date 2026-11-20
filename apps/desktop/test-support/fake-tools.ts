import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 테스트용 가짜 JRE·Maestro 묶음과 로컬 HTTP 서버.
 * 가짜 maestro 는 JAVA_HOME 이 없거나 사용자 PATH(/opt/homebrew/bin 등)가 섞이면 실패한다.
 */
export const FAKE_JRE_VERSION = "21-fake";
export const FAKE_MAESTRO_VERSION = "9.9.9-fake";
export const FAKE_AGENT_DEVICE_VERSION = "0.0.0-fake";
/** 가짜 maestro test 가 내는 실제 산출물(packages/evidence/fixtures) */
const FIXTURES_DIR = resolve(__dirname, "../../../packages/evidence/fixtures");

/** 가짜 Android SDK 의 에뮬레이터 하나(실행 중) */
export const FAKE_AVD = "Avocado_E2E_Pixel";

/**
 * 가짜 Android SDK(ANDROID_HOME). emulator -list-avds 와 adb 가 실행 중인 에뮬레이터 하나(emulator-5554)를 보인다.
 * 실행 전 드라이버 정리(am force-stop)와 기기 정보(getprop)에 답한다. 부르는 인자는 calls.log 에 남는다
 */
export function buildFakeAndroidSdk(): { dir: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "qa-fake-android-"));
  const log = join(dir, "calls.log");
  mkdirSync(join(dir, "emulator"));
  mkdirSync(join(dir, "platform-tools"));
  writeExecutable(join(dir, "emulator", "emulator"), ["#!/bin/sh", `echo "emulator $*" >> "${log}"`, `if [ "$1" = "-list-avds" ]; then echo "${FAKE_AVD}"; fi`, ""].join("\n"));
  writeExecutable(
    join(dir, "platform-tools", "adb"),
    [
      "#!/bin/sh",
      `echo "adb $*" >> "${log}"`,
      'if [ "$1" = "devices" ]; then printf "List of devices attached\\nemulator-5554\\tdevice\\n\\n"; exit 0; fi',
      `if [ "$3" = "emu" ]; then printf "${FAKE_AVD}\\nOK\\n"; exit 0; fi`,
      'if [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then case "$5" in persist.sys.locale) echo ko-KR;; ro.build.version.release) echo 15;; *) echo;; esac; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  return { dir, calls: () => (readFileSync(log, { encoding: "utf8", flag: "a+" }) || "").split("\n").filter(Boolean) };
}

export interface FakeArchives {
  dir: string;
  jre: string;
  maestro: string;
  /** npm 묶음 모양(package/bin/agent-device.mjs) */
  agentDevice: string;
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
      // check-syntax - : 표준 입력을 읽어 없는 명령 tapOnn 만 실제 Maestro 2.11.0 과 같은 꼴의 오류로 낸다
      // test: 실제 Maestro 2.11.0 의 Android 산출물 픽스처를 출력 폴더로 낸다. 플로우에 AVOCADO_E2E_FAIL 이 있으면 실패 픽스처
      'case " $* " in *" test "*)',
      '  out=""; junit=""; flow=""',
      '  while [ $# -gt 0 ]; do case "$1" in --test-output-dir) out="$2"; shift 2;; --output) junit="$2"; shift 2;; --device|--format|-e) shift 2;; *) flow="$1"; shift;; esac; done',
      '  fixture=android-pass; if grep -q AVOCADO_E2E_FAIL "$flow"; then fixture=android-fail; fi',
      `  fix="${FIXTURES_DIR}/$fixture"`,
      "  sleep 1",
      '  mkdir -p "$out" && cp -R "$fix/maestro/." "$out/" && cp "$fix/junit.xml" "$junit"',
      '  cat "$fix/console.log"',
      '  exit "$(cat "$fix/exit-code")";;',
      "esac",
      'if [ "$1" = "check-syntax" ]; then',
      '  body=$(cat)',
      '  case "$body" in *tapOnn*) echo; echo "Invalid Command: tapOnn at /syntax-checker:3:9" >&2; exit 1;; esac',
      '  echo; echo "OK"; exit 0',
      "fi",
      `echo "${FAKE_MAESTRO_VERSION}"`,
      "",
    ].join("\n"),
  );
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(dir, "src-maestro", "maestro"), join(dir, "maestro.zip")]);

  const adBin = join(dir, "src-agent-device", "package", "bin");
  mkdirSync(adBin, { recursive: true });
  writeFileSync(join(adBin, "agent-device.mjs"), `console.log("${FAKE_AGENT_DEVICE_VERSION}");\n`);
  execFileSync("/usr/bin/tar", ["-czf", join(dir, "agent-device.tgz"), "-C", join(dir, "src-agent-device"), "package"]);
  return { dir, jre: join(dir, "jre.tar.gz"), maestro: join(dir, "maestro.zip"), agentDevice: join(dir, "agent-device.tgz") };
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
    "agent-device": {
      id: "agent-device" as const,
      version: FAKE_AGENT_DEVICE_VERSION,
      url: `${baseUrl}/agent-device.tgz`,
      sha256: sha256(archives.agentDevice),
      sizeBytes: statSync(archives.agentDevice).size,
      archive: "tar.gz" as const,
    },
  };
}
