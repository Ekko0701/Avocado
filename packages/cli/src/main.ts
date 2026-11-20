import { homedir } from "node:os";
import { runCli } from "./commands";
import { EXIT } from "./exit-codes";

// avocado 명령의 진입점. 진행은 stderr, 결과(요약·--json)는 stdout 으로 낸다
let onInterrupt: (() => void) | null = null;
let interrupts = 0;
process.on("SIGINT", () => {
  interrupts += 1;
  // run 은 첫 Ctrl-C 에 자기 묶음을 취소하고 끝날 때까지 기다린다. 두 번째는 기다리지 않고 끝낸다
  if (onInterrupt && interrupts === 1) onInterrupt();
  else process.exit(onInterrupt ? EXIT.canceled : 130);
});

runCli(process.argv.slice(2), {
  io: { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
  env: process.env,
  home: homedir(),
  onInterrupt: (handler) => {
    onInterrupt = handler;
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`avocado: 예상하지 못한 오류: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = EXIT.error;
  },
);
