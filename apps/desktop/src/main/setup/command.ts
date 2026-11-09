import { execFile } from "node:child_process";

export interface CommandResult {
  /** 종료 코드. 실행 자체를 못 했으면 -1 */
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  /** input: 표준 입력으로 넘길 내용. 없으면 표준 입력을 바로 닫는다 */
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string; input?: string },
) => Promise<CommandResult>;

/**
 * 셸을 거치지 않고 실행한다(CLAUDE.md 5장). 0 이 아닌 종료 코드는 예외가 아니라 결과로 돌려준다.
 * Finder 로 실행한 앱은 PATH 가 최소이므로 호출하는 쪽은 절대 경로를 넘긴다.
 */
export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 30_000,
        env: options.env ?? process.env,
        cwd: options.cwd,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === "number" ? error.code : -1;
        // 제한 시간으로 죽인 경우 execFile 은 "Command failed" 만 남기므로 원인을 분명히 적는다.
        const timedOut = error.killed === true || error.signal === "SIGTERM";
        const reason = timedOut ? `시간 초과(${Math.round((options.timeoutMs ?? 30_000) / 1000)}초)로 중단됨. ` : "";
        resolve({ code, stdout: stdout ?? "", stderr: `${reason}${stderr || error.message}` });
      },
    );
    // 프로세스가 입력을 읽기 전에 끝나면 EPIPE 가 난다. 결과(종료 코드·stderr)는 위 콜백이 돌려주므로 여기서는 프로세스를 죽게 두지 않는다
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
