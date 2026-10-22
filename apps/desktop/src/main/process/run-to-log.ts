import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface LoggedProcessOptions {
  args?: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** 표준 출력과 오류를 함께 쓸 파일(추가 모드, 0600) */
  logFile: string;
  timeoutMs: number;
  /** 중단하면 프로세스 그룹을 끝낸다 */
  signal?: AbortSignal;
}

export interface LoggedProcessResult {
  /** 종료 코드. 실행하지 못했거나 시간 초과·취소로 중단했으면 -1 */
  code: number;
  timedOut: boolean;
  canceled: boolean;
}

export type LoggedProcessRunner = (file: string, options: LoggedProcessOptions) => Promise<LoggedProcessResult>;

/**
 * 셸 없이 실행하고 출력을 로그 파일로 바로 흘려보낸다. xcodebuild·maestro 처럼 출력이 큰 명령도 메모리에 쌓지 않는다.
 * detached 로 띄워 하위 프로세스(xcodebuild, java 등)를 한 그룹으로 묶고, 시간 초과·취소 때 그룹 전체를 끝낸다.
 */
export const runToLog: LoggedProcessRunner = (file, { args = [], env, cwd, logFile, timeoutMs, signal }) =>
  new Promise((resolve) => {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a", 0o600);
    let timedOut = false;
    let canceled = false;
    let settled = false;
    const child = spawn(file, [...args], { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      // SIGTERM 을 무시하는 하위 프로세스가 남지 않게 잠시 뒤 강제 종료
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // 이미 끝났다
        }
      }, 5000).unref();
    };
    const onAbort = () => {
      canceled = true;
      killGroup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) writeSync(fd, `\n[qa] 시간 초과(${Math.round(timeoutMs / 1000)}초)로 중단함\n`);
      if (canceled) writeSync(fd, "\n[qa] 사용자가 취소함\n");
      closeSync(fd);
      resolve({ code: timedOut || canceled ? -1 : code, timedOut, canceled });
    };
    child.on("error", (error) => {
      writeSync(fd, `\n[qa] 실행 실패: ${error.message}\n`);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
