import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * git 인증 도우미(GIT_ASKPASS, PLAN 10.2). VS Code 의 방식처럼 토큰을 환경 변수·파일·URL 에 두지 않는다.
 * - 도우미 스크립트는 앱 main 의 Unix 소켓(0700 폴더)에 일회용 nonce 와 함께 git 의 질문(prompt)을 보낸다.
 * - main 은 nonce 가 맞을 때만 사용자 이름·토큰을 돌려준다. git 명령이 끝나면 nonce 를 지운다.
 * git 자식 프로세스 환경에는 소켓 경로와 nonce 만 있다.
 */
const SCRIPT = `#!/bin/sh
# Avocado git 인증 도우미. 토큰은 이 파일과 환경 변수에 없다. 앱에 일회용 nonce 로 묻는다.
exec /usr/bin/curl -sS --fail --max-time 10 --unix-socket "$QA_ASKPASS_SOCKET" -H "X-QA-Nonce: $QA_ASKPASS_NONCE" --data-urlencode "prompt=$1" http://askpass/
`;

export interface Credential {
  username: string;
  password: string;
}

export interface AskpassSession {
  /** git 자식 프로세스에 더할 환경 변수(토큰 없음) */
  env: Record<string, string>;
  dispose(): void;
}

export class AskpassServer {
  private readonly sessions = new Map<string, Credential>();
  /** 도우미가 실제로 답한 횟수(테스트·진단용) */
  answered = 0;

  private constructor(
    private readonly dir: string,
    private readonly server: Server,
    readonly socketPath: string,
    readonly scriptPath: string,
  ) {}

  static async start(): Promise<AskpassServer> {
    // macOS 소켓 경로는 104바이트 제한이 있어 짧은 임시 폴더를 쓴다
    const dir = mkdtempSync(join(tmpdir(), "qa-askpass-"));
    chmodSync(dir, 0o700);
    const scriptPath = join(dir, "askpass.sh");
    writeFileSync(scriptPath, SCRIPT, { mode: 0o700 });
    const socketPath = join(dir, "s");
    let self: AskpassServer | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const answer = self?.answer(String(req.headers["x-qa-nonce"] ?? ""), new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("prompt") ?? "");
        if (answer === null || answer === undefined) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" }).end(answer);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    self = new AskpassServer(dir, server, socketPath, scriptPath);
    return self;
  }

  /** git 명령 하나에 쓸 세션. 끝나면 dispose 한다 */
  session(credential: Credential): AskpassSession {
    const nonce = randomBytes(24).toString("hex");
    this.sessions.set(nonce, credential);
    return {
      env: { GIT_ASKPASS: this.scriptPath, QA_ASKPASS_SOCKET: this.socketPath, QA_ASKPASS_NONCE: nonce },
      dispose: () => this.sessions.delete(nonce),
    };
  }

  private answer(nonce: string, prompt: string): string | null {
    let found: Credential | null = null;
    for (const [key, value] of this.sessions) {
      const a = Buffer.from(key);
      const b = Buffer.from(nonce);
      if (a.length === b.length && timingSafeEqual(a, b)) found = value;
    }
    if (!found) return null;
    this.answered += 1;
    if (/^username/i.test(prompt)) return found.username;
    if (/^password/i.test(prompt)) return found.password;
    return null;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}
