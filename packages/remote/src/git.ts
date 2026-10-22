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
}

/**
 * 시스템 git 을 셸 없이 실행한다(CLAUDE.md 5·6장).
 * - 환경은 새로 만든다. 부모의 GIT_TRACE·GIT_CURL_VERBOSE(인증 헤더를 로그에 쓴다) 같은 변수를 넘기지 않는다.
 * - credential.helper 를 비워 osxkeychain·store 같은 도우미가 토큰을 디스크·키체인에 저장하지 못하게 한다.
 * - 터미널 프롬프트를 끄고, 인증은 GIT_ASKPASS 도우미로만 한다.
 */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    HOME: options.home ?? homedir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    ...(options.askpass?.env ?? {}),
  };
  const fullArgs = ["-c", "credential.helper=", "-c", "core.askPass=", ...args];
  return new Promise((resolve) => {
    execFile(
      options.gitPath ?? "/usr/bin/git",
      fullArgs,
      { cwd: options.cwd, env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        const secrets = options.secrets ?? [];
        resolve({ code, stdout: scrubSecrets(stdout ?? "", secrets), stderr: scrubSecrets(stderr || (error && code === -1 ? error.message : ""), secrets) });
      },
    );
  });
}
