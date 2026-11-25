import type { RunBatch, RunOptions, StartRunsInput } from "@qa/shared";
import { describe, expect, it } from "vitest";
import type { McpConnection } from "../agent/author-service";
import { routeMcpPorts } from "./mcp-server";
import { RunStartFailure, type RunOrigin } from "../runs/run-batch";
import { createRunPort, RUN_TOOL_NAMES } from "./run-port";

const CLI: McpConnection = { id: "conn-cli", client: "avocado-cli 0.1.0" };
const CLAUDE: McpConnection = { id: "conn-claude", client: "claude-ai 1.2" };

const batch = (over: Partial<RunBatch> = {}): RunBatch => ({
  id: "b1",
  origin: "avocado-cli 0.1.0",
  app: "demo",
  target: "ios",
  deviceId: "SIM",
  buildId: null,
  items: [{ tcId: "TC-0101", runId: null, status: "running", failureMessage: null }],
  skipped: [],
  state: "running",
  errors: [],
  ...over,
});

function port(over: { start?: (input: StartRunsInput, origin: RunOrigin) => Promise<RunBatch>; holders?: string[] } = {}) {
  const calls: { start: [StartRunsInput, RunOrigin][]; cancel: string[]; wait: [string, number][] } = { start: [], cancel: [], wait: [] };
  const known = new Map([["b1", batch()]]);
  const p = createRunPort({
    start: (input, origin) => {
      calls.start.push([input, origin]);
      return over.start ? over.start(input, origin) : Promise.resolve(batch());
    },
    options: (): Promise<RunOptions> =>
      Promise.resolve({ appVersion: "0.2.0", workspaceConnected: true, apps: [{ app: "demo", testcases: [{ id: "TC-0101", title: "로그인", tags: ["smoke"], status: "active", flows: ["ios"] }] }], devices: [], builds: [], busy: null }),
    queue: {
      batch: (id) => known.get(id) ?? null,
      waitForChange: (id, ms) => {
        calls.wait.push([id, ms]);
        return Promise.resolve(known.get(id) ?? null);
      },
      cancel: (id) => {
        calls.cancel.push(id);
        const b = known.get(id);
        return b ? { ...b, state: "done" } : null;
      },
    },
    holdsJob: (id) => (over.holders ?? []).includes(id),
  });
  return { p, calls };
}

const parse = (r: { content: { type: string; text?: string }[] }): unknown => JSON.parse(r.content[0]?.text ?? "null");

describe("MCP 실행 포트(ADR 0035)", () => {
  it("도구 넷이고 다른 포트와 이름이 겹치지 않는다", () => {
    const { p } = port();
    expect([...RUN_TOOL_NAMES]).toEqual(["run_options", "start_runs", "runs_status", "cancel_runs"]);
    expect(() => routeMcpPorts([p, { tools: () => [{ name: "attach_author", description: "", inputSchema: { type: "object" } }], call: () => Promise.resolve({ content: [] }) }])).not.toThrow();
    const start = p.tools().find((t) => t.name === "start_runs");
    expect(start?.inputSchema).toMatchObject({ type: "object", properties: { app: {}, tcIds: {}, tag: {}, deviceId: {}, buildId: {} } });
  });

  it("start_runs: 연결의 클라이언트 이름을 origin 으로 넘기고 묶음을 돌려준다. 거절은 code 와 함께 오류 결과", async () => {
    const { p, calls } = port();
    const ok = await p.call(CLI, "start_runs", { app: "demo", tcIds: ["TC-0101"] });
    expect(ok.isError).toBeUndefined();
    expect(parse(ok)).toMatchObject({ batch: { id: "b1", origin: "avocado-cli 0.1.0" } });
    expect(calls.start[0]).toEqual([{ app: "demo", tcIds: ["TC-0101"] }, { via: "mcp", client: "avocado-cli 0.1.0" }]);

    const refused = port({ start: () => Promise.reject(new RunStartFailure("device_ambiguous", "준비된 기기가 여럿이다", ["A (iPhone)", "B (iPad)"])) });
    const r = await refused.p.call(CLI, "start_runs", { app: "demo", tag: "smoke" });
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({ error: { code: "device_ambiguous", message: "준비된 기기가 여럿이다", candidates: ["A (iPhone)", "B (iPad)"] } });

    const bad = await p.call(CLI, "start_runs", { app: "demo", tcIds: ["TC-0101"], tag: "smoke" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ text: expect.stringContaining("입력 형식") as unknown });
    expect(calls.start).toHaveLength(1);
  });

  it("작업(플로우 만들기·화면 판정)을 맡은 연결은 실행을 시작·취소하지 못한다(caller_busy). 조회는 된다", async () => {
    const { p, calls } = port({ holders: [CLAUDE.id] });
    expect(parse(await p.call(CLAUDE, "start_runs", { app: "demo", tcIds: ["TC-0101"] }))).toMatchObject({ error: { code: "caller_busy" } });
    expect(parse(await p.call(CLAUDE, "cancel_runs", { batchId: "b1" }))).toMatchObject({ error: { code: "caller_busy" } });
    expect(calls.start).toEqual([]);
    expect(calls.cancel).toEqual([]);
    expect(parse(await p.call(CLAUDE, "runs_status", { batchId: "b1" }))).toMatchObject({ id: "b1" });
  });

  it("runs_status·cancel_runs 는 그 id 의 묶음만. 모르는 id 는 오류, 기다림은 45초까지", async () => {
    const { p, calls } = port();
    expect(parse(await p.call(CLI, "runs_status", { batchId: "b1", waitSeconds: 45 }))).toMatchObject({ id: "b1", state: "running" });
    expect(calls.wait).toEqual([["b1", 45_000]]);
    expect((await p.call(CLI, "runs_status", { batchId: "b1", waitSeconds: 46 })).isError).toBe(true);
    const gone = await p.call(CLI, "runs_status", { batchId: "other" });
    expect(gone.isError).toBe(true);
    expect(parse(gone)).toMatchObject({ error: { code: "unknown_batch" } });
    expect(parse(await p.call(CLI, "cancel_runs", { batchId: "b1" }))).toMatchObject({ id: "b1", state: "done" });
    expect((await p.call(CLI, "cancel_runs", { batchId: "other" })).isError).toBe(true);
    expect(calls.cancel).toEqual(["b1", "other"]);
  });

  it("run_options 는 앱 버전과 목록을 준다", async () => {
    const { p } = port();
    expect(parse(await p.call(CLI, "run_options", {}))).toMatchObject({ appVersion: "0.2.0", apps: [{ app: "demo" }] });
  });
});
