import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** 에뮬레이터처럼 앱과 별개로 계속 도는 프로세스를 분리 실행한다. 셸을 거치지 않는다. */
export function spawnDetached(file: string, args: string[], logFile: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(file, args, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
  } finally {
    closeSync(fd);
  }
}
