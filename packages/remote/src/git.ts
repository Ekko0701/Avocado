import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { AskpassSession } from "./askpass";
import { scrubSecrets } from "./scrub";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunGitOptions {
  cwd: string;
  /** 원격 인증이 필요한 명령에만 준다 */
  askpass?: AskpassSession;
  /** 출력에서 지울 값(토큰). 출력에 나올 일이 없어도 한 번 더 지운다 */
  secrets?: readonly string[];
  timeoutMs?: number;
  /** 기본 사용자 홈. 전역 설정(user.name 등)을 읽는다 */
  home?: string;
  gitPath?: string;
  /** 더할 환경 변수(예: 임시 색인 GIT_INDEX_FILE) */
  env?: Readonly<Record<string, string>>;
  /** 표준 입력으로 넘길 바이트(예: hash-object --stdin, cat-file --batch) */
  input?: Uint8Array;
}

export interface GitBytesResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * 시스템 git 을 셸 없이 실행한다(CLAUDE.md 5·6장).
 * - 환경은 새로 만든다. 부모의 GIT_TRACE·GIT_CURL_VERBOSE(인증 헤더를 로그에 쓴다) 같은 변수를 넘기지 않는다.
 * - credential.helper 를 비워 osxkeychain·store 같은 도우미가 토큰을 디스크·키체인에 저장하지 못하게 한다.
 * - 터미널 프롬프트를 끄고, 인증은 GIT_ASKPASS 도우미로만 한다.
 */
export async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
  const r = await runGitBytes(args, options);
  return { code: r.code, stdout: scrubSecrets(r.stdout.toString("utf8"), options.secrets ?? []), stderr: r.stderr };
}

/** runGit 과 같고 표준 출력을 바이트 그대로 돌려준다(파일 내용을 읽을 때). 표준 출력은 지우지 않으므로 인증이 필요한 명령에는 쓰지 않는다 */
export function runGitBytes(args: readonly string[], options: RunGitOptions): Promise<GitBytesResult> {
  const env: NodeJS.ProcessEnv = {
    HOME: options.home ?? homedir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    ...(options.askpass?.env ?? {}),
    ...(options.env ?? {}),
  };
  const fullArgs = ["-c", "credential.helper=", "-c", "core.askPass=", ...args];
  return new Promise((resolve) => {
    const child = execFile(
      options.gitPath ?? "/usr/bin/git",
      fullArgs,
      { cwd: options.cwd, env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        const text = stderr.toString("utf8");
        resolve({ code, stdout, stderr: scrubSecrets(text || (error && code === -1 ? error.message : ""), options.secrets ?? []) });
      },
    );
    if (options.input) child.stdin?.end(options.input);
  });
}
