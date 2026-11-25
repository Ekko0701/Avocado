import { describe, expect, it } from "vitest";
import { ArgError, parseArgs, parseTestcaseRef } from "./args";
import { socketPath } from "./client";
import { EXIT, START_ERROR_EXIT, batchExit } from "./exit-codes";

describe("인자 해석", () => {
  it("테스트 케이스는 <앱>-TC-<번호> 와 <앱>/TC-<번호>. 앱 id 에 하이픈이 있어도 된다", () => {
    expect(parseTestcaseRef("demo-TC-0101")).toEqual({ app: "demo", tcId: "TC-0101" });
    expect(parseTestcaseRef("demo/TC-0101")).toEqual({ app: "demo", tcId: "TC-0101" });
    expect(parseTestcaseRef("my-app-TC-12345")).toEqual({ app: "my-app", tcId: "TC-12345" });
    for (const bad of ["demo", "TC-0101", "Demo-TC-0101", "demo-TC-01", "demo-tc-0101", "-TC-0101"]) expect(() => parseTestcaseRef(bad), bad).toThrow(ArgError);
  });

  it("run: 여러 TC(중복은 하나로), 옵션은 --x v 와 --x=v", () => {
    expect(parseArgs(["qa", "run", "demo-TC-0101", "demo/TC-0102", "demo-TC-0101", "--target=ios", "--device", "SIM", "--build", "b1", "--json"])).toEqual({
      kind: "run",
      app: "demo",
      tcIds: ["TC-0101", "TC-0102"],
      target: "ios",
      device: "SIM",
      build: "b1",
      json: true,
    });
    expect(parseArgs(["qa", "run", "--app", "demo", "--tag", "smoke"])).toEqual({ kind: "run", app: "demo", tag: "smoke", json: false });
  });

  it("run 의 인자 오류", () => {
    const bad: string[][] = [
      ["qa", "run"],
      ["qa", "run", "demo-TC-0101", "sample-TC-0002"],
      ["qa", "run", "--tag", "smoke"],
      ["qa", "run", "demo-TC-0101", "--tag", "smoke", "--app", "demo"],
      ["qa", "run", "demo-TC-0101", "--app", "demo"],
      ["qa", "run", "demo-TC-0101", "--target", "web"],
      ["qa", "run", "demo-TC-0101", "--device"],
      ["qa", "run", "demo-TC-0101", "--device", "--json"],
      ["qa", "run", "demo-TC-0101", "--device", "A", "--device", "B"],
      ["qa", "run", "demo-TC-0101", "--reauthor"],
      ["qa", "run", "demo-TC-0101", "--json=1"],
      ["qa", "run", "demo-TC-0101", "--no-wait"],
    ];
    for (const argv of bad) expect(() => parseArgs(argv), argv.join(" ")).toThrow(ArgError);
  });

  it("status·cancel·options·help", () => {
    expect(parseArgs(["qa", "status", "batch-1"])).toEqual({ kind: "status", batchId: "batch-1", json: false, follow: true });
    expect(parseArgs(["qa", "status", "batch-1", "--no-wait", "--json"])).toEqual({ kind: "status", batchId: "batch-1", json: true, follow: false });
    expect(parseArgs(["qa", "cancel", "batch-1"])).toEqual({ kind: "cancel", batchId: "batch-1", json: false });
    expect(parseArgs(["qa", "options", "--json"])).toEqual({ kind: "options", json: true });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["qa", "run", "-h"])).toEqual({ kind: "help" });
    for (const argv of [[], ["run"], ["qa"], ["qa", "list"], ["qa", "status"], ["qa", "status", "a", "b"], ["qa", "cancel", "a", "--no-wait"], ["qa", "options", "x"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(ArgError);
    }
  });

  it("소켓 경로: AVOCADO_SOCKET → QA_USER_DATA_DIR(개발 실행) → 설치한 앱의 앱 데이터", () => {
    expect(socketPath({ AVOCADO_SOCKET: "/tmp/a.sock", QA_USER_DATA_DIR: "/tmp/u" }, "/Users/me")).toBe("/tmp/a.sock");
    expect(socketPath({ QA_USER_DATA_DIR: "/tmp/u" }, "/Users/me")).toBe("/tmp/u/mcp/avocado.sock");
    expect(socketPath({}, "/Users/me")).toBe("/Users/me/Library/Application Support/Avocado/mcp/avocado.sock");
  });
});

describe("종료 코드", () => {
  const item = (status: "passed" | "failed" | "error" | "canceled") => ({ tcId: "TC-0001", runId: "r", status, failureMessage: null });
  it("끝난 묶음: 오류 6 > 취소 4 > 실패 1 > 건너뜀 5 > 통과 0", () => {
    const skipped = [{ tcId: "TC-0009", reason: "no_flow" as const }];
    expect(batchExit({ items: [item("passed")], skipped: [] })).toBe(EXIT.ok);
    expect(batchExit({ items: [item("passed")], skipped })).toBe(EXIT.noFlow);
    expect(batchExit({ items: [item("failed")], skipped })).toBe(EXIT.failed);
    expect(batchExit({ items: [item("failed"), item("canceled")], skipped })).toBe(EXIT.canceled);
    expect(batchExit({ items: [item("canceled"), item("error")], skipped })).toBe(EXIT.error);
  });
  it("시작 거절: 인자를 고치면 되는 것 2, 플로우 없음 5, 앱·기기 상태 6", () => {
    expect(START_ERROR_EXIT).toEqual({
      unknown_app: 2,
      unknown_testcase: 2,
      bad_build: 2,
      device_ambiguous: 2,
      no_flow: 5,
      device_not_ready: 6,
      queue_busy: 6,
      workspace_not_connected: 6,
      caller_busy: 6,
    });
  });
});
