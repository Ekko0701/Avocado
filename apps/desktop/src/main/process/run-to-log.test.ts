import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runToLog } from "./run-to-log";

const dir = () => mkdtempSync(join(tmpdir(), "qa-proc-"));

describe("로그로 흘려보내는 실행", () => {
  it("인자를 셸 없이 넘기고 출력을 파일에 쓴다", async () => {
    const d = dir();
    const r = await runToLog("/bin/echo", { args: ["a b", "$HOME", ";rm"], env: {}, cwd: d, logFile: join(d, "out.log"), timeoutMs: 5000 });
    expect(r).toEqual({ code: 0, timedOut: false, canceled: false });
    expect(readFileSync(join(d, "out.log"), "utf8")).toBe("a b $HOME ;rm\n");
  });

  it("취소하면 하위 프로세스까지 바로 끝내고 canceled 로 돌려준다", async () => {
    const d = dir();
    const abort = new AbortController();
    const started = Date.now();
    const p = runToLog("/bin/sh", { args: ["-c", "sleep 30 & wait"], env: {}, cwd: d, logFile: join(d, "out.log"), timeoutMs: 60_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    expect(await p).toEqual({ code: -1, timedOut: false, canceled: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readFileSync(join(d, "out.log"), "utf8")).toContain("사용자가 취소함");
  });
});
