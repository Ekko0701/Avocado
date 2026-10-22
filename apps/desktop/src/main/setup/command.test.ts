import { describe, expect, it } from "vitest";
import { runCommand } from "./command";

describe("runCommand", () => {
  it("0 이 아닌 종료 코드는 예외가 아니라 결과로 돌려준다", async () => {
    const r = await runCommand("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toContain("err");
  });

  it("제한 시간으로 중단되면 그 사실을 오류에 적는다", async () => {
    const r = await runCommand("/bin/sleep", ["5"], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("시간 초과(0초)로 중단됨");
  });

  it("없는 실행 파일은 -1 로 알린다", async () => {
    const r = await runCommand("/no/such/binary", []);
    expect(r.code).toBe(-1);
  });
});
