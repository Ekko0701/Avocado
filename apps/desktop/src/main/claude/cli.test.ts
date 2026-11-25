import { EXIT, runCli } from "@qa/cli";
import type { Device, RunBatch, RunOptions, RunSummary } from "@qa/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunBatch, type RunBatchDeps } from "../runs/run-batch";
import { RunQueue, type QueuedRun } from "../runs/run-queue";
import { createAvocadoMcpServer, routeMcpPorts } from "./mcp-server";
import { createRunPort } from "./run-port";
import { McpSocketHost } from "./socket-host";

// avocado CLI(T-121, ADR 0035)를 실제 소켓 호스트·MCP 서버·실행 포트·실행 큐에 붙인다. 바꿔 끼운 것은 RunService(실행)와 기기·워크스페이스뿐이다

const SIM: Device = { id: "SIM", platform: "ios", kind: "simulator", name: "iPhone 16", osVersion: "18.0", state: "booted", managed: true, serial: null, locale: null };
type Outcome = "passed" | "failed" | "error" | "hold";
/** TC 마다 결과. hold 는 취소될 때까지 끝나지 않는다 */
const OUTCOME: Record<string, Outcome> = { "TC-0101": "passed", "TC-0102": "passed", "TC-0103": "failed", "TC-0104": "error", "TC-0109": "hold" };
const FLOWS = ["TC-0101", "TC-0102", "TC-0103", "TC-0104", "TC-0109"];

let dir: string;
let host: McpSocketHost;
let queue: RunQueue;
let canceled: string[];
let devices: Device[];

function fakeRuns() {
  const status = new Map<string, RunSummary["status"]>();
  const done = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();
  let n = 0;
  return {
    start: (input: QueuedRun["input"]) => {
      const id = `run-${++n}`;
      const tc = /TC-\d+/.exec(input.flowPath)?.[0] ?? "";
      const outcome = OUTCOME[tc] ?? "passed";
      status.set(id, "running");
      waits.set(
        id,
        new Promise<void>((resolve) => {
          done.set(id, resolve);
          if (outcome !== "hold") {
            setTimeout(() => {
              status.set(id, outcome);
              resolve();
            }, 20);
          }
        }),
      );
      return Promise.resolve({ id } as RunSummary);
    },
    wait: (id: string) => waits.get(id) ?? Promise.resolve(),
    cancel: (id: string) => {
      status.set(id, "canceled");
      done.get(id)?.();
      return { id } as RunSummary;
    },
    summary: (id: string) => ({ id, status: status.get(id) ?? "error", failureMessage: status.get(id) === "error" ? "설치 실패" : status.get(id) === "failed" ? "요소를 찾지 못했다" : null }) as RunSummary,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
  canceled = [];
  devices = [SIM];
  queue = new RunQueue(fakeRuns());
  const deps: RunBatchDeps = {
    workspace: {
      runPlan: (input) => {
        if (input.app !== "demo") return { known: false, apps: ["demo"], appId: null, flows: [], missing: [], noFlow: [] };
        const all = ["TC-0101", "TC-0102", "TC-0103", "TC-0104", "TC-0105", "TC-0109"];
        const picked = input.tcIds ? input.tcIds.filter((t) => all.includes(t)) : input.tag === "smoke" ? ["TC-0101", "TC-0105"] : [];
        return {
          known: true,
          apps: ["demo"],
          appId: "com.example.demo",
          flows: picked.filter((t) => FLOWS.includes(t)).map((tcId) => ({ tcId, path: `/ws/${tcId}.yaml`, envKeys: [] })),
          missing: input.tcIds ? input.tcIds.filter((t) => !all.includes(t)) : [],
          noFlow: picked.filter((t) => !FLOWS.includes(t)),
        };
      },
      appTargets: () => ["ios"],
    },
    builds: {
      get: () => {
        throw new Error("없음");
      },
    },
    devices: { list: () => Promise.resolve({ devices }) },
    queue,
    iosDeviceProblem: () => Promise.resolve(null),
    deviceBusy: () => null,
  };
  const realCancel = queue.cancel.bind(queue);
  const port = routeMcpPorts([
    createRunPort({
      start: (input, origin) => startRunBatch(deps, input, origin),
      options: (): Promise<RunOptions> =>
        Promise.resolve({ appVersion: "9.9.9", workspaceConnected: true, apps: [{ app: "demo", testcases: [{ id: "TC-0101", title: "첫 화면", tags: ["smoke"], status: "active", flows: ["ios"] }] }], devices: [{ id: "SIM", name: "iPhone 16", platform: "ios", kind: "simulator" }], builds: [], busy: null }),
      queue: {
        batch: (id) => queue.batch(id),
        waitForChange: (id, ms) => queue.waitForChange(id, ms),
        cancel: (id) => {
          canceled.push(id);
          return realCancel(id);
        },
      },
      holdsJob: () => false,
    }),
  ]);
  host = new McpSocketHost({
    socketPath: join(dir, "mcp", "avocado.sock"),
    createServer: (connectionId, onInitialized) => createAvocadoMcpServer({ port, version: "9.9.9", connectionId, onInitialized }),
    onDisconnect: () => undefined,
    log: () => undefined,
  });
  await host.start();
});

afterEach(async () => {
  await host.close();
  await queue.idle();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(argv: string[], opts: { interruptAfterStart?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let interrupt: (() => void) | null = null;
  const code = await runCli(argv, {
    io: {
      out: (l) => out.push(l),
      err: (l) => {
        err.push(l);
        if (opts.interruptAfterStart && l.startsWith("Ctrl-C") && interrupt) interrupt();
      },
    },
    env: { QA_USER_DATA_DIR: dir },
    home: dir,
    waitSeconds: 1,
    onInterrupt: (h) => {
      interrupt = h;
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("avocado CLI ↔ 앱 소켓(T-121)", () => {
  it("0 모두 통과: 연결한 앱 버전과 진행을 stderr 에, 요약을 stdout 에. --json 은 묶음 JSON 하나", async () => {
    const r = await cli(["qa", "run", "demo-TC-0101", "demo/TC-0102"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toContain("Avocado 9.9.9 에 연결했다");
    expect(r.err).toMatch(/TC-0101 실행 중[\s\S]*TC-0101 통과/);
    expect(r.out).toContain("TC-0102  통과");
    const j = await cli(["qa", "run", "demo-TC-0101", "--json"]);
    expect(j.code).toBe(EXIT.ok);
    expect(j.err).toBe("");
    const batch = JSON.parse(j.out) as RunBatch;
    expect(batch).toMatchObject({ origin: "avocado-cli 0.1.0", state: "done", items: [{ tcId: "TC-0101", status: "passed" }] });
  });

  it("1 실패, 6 오류로 끝난 실행", async () => {
    const failed = await cli(["qa", "run", "demo-TC-0101", "demo-TC-0103"]);
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.err).toContain("TC-0103 실패 · 요소를 찾지 못했다");
    expect((await cli(["qa", "run", "demo-TC-0104", "demo-TC-0101"])).code).toBe(EXIT.error);
  });

  it("2 인자 오류: 형식, 없는 앱, 없는 TC, 기기가 여럿, 모르는 묶음 id", async () => {
    expect((await cli(["qa", "run", "TC-0101"])).code).toBe(EXIT.args);
    const app = await cli(["qa", "run", "nope-TC-0101"]);
    expect(app.code).toBe(EXIT.args);
    expect(app.err).toContain("후보: demo");
    expect((await cli(["qa", "run", "demo-TC-9999"])).code).toBe(EXIT.args);
    devices = [SIM, { ...SIM, id: "SIM2", name: "iPhone 15" }];
    const two = await cli(["qa", "run", "demo-TC-0101"]);
    expect(two.code).toBe(EXIT.args);
    expect(two.err).toContain("--device <id>");
    expect((await cli(["qa", "status", "batch-none"])).code).toBe(EXIT.args);
  });

  it("3 앱에 연결하지 못함: 소켓이 없거나 도중에 앱이 꺼짐", async () => {
    const gone = await runCli(["qa", "options"], { io: { out: () => undefined, err: () => undefined }, env: { AVOCADO_SOCKET: join(dir, "nope.sock") }, home: dir });
    expect(gone).toBe(EXIT.connect);
    const closing = cli(["qa", "run", "demo-TC-0109"]);
    await new Promise((r) => setTimeout(r, 300));
    await host.close();
    const r = await closing;
    expect(r.code).toBe(EXIT.connect);
    expect(r.err).toContain("연결이 끊겼다");
    queue.clear();
  });

  it("4 Ctrl-C 는 자기 묶음만 취소하고 끝날 때까지 기다린다", async () => {
    const before = await cli(["qa", "run", "demo-TC-0101", "--json"]);
    const earlier = (JSON.parse(before.out) as RunBatch).id;
    const r = await cli(["qa", "run", "demo-TC-0109", "demo-TC-0101"], { interruptAfterStart: true });
    expect(r.code).toBe(EXIT.canceled);
    expect(canceled).toHaveLength(1);
    expect(canceled[0]).not.toBe(earlier);
    expect(r.err).toContain(`취소를 요청했다: ${canceled[0] ?? ""}`);
    expect(r.out).toMatch(/TC-0109 {2}취소[\s\S]*TC-0101 {2}취소/);
    expect(queue.batch(earlier)?.items[0]?.status).toBe("passed");
  });

  it("5 플로우가 없어 돌리지 않은 TC 가 있음: 태그 실행의 건너뜀, 돌릴 것이 하나도 없으면 시작 거절", async () => {
    const r = await cli(["qa", "run", "--app", "demo", "--tag", "smoke"]);
    expect(r.code).toBe(EXIT.noFlow);
    expect(r.err).toContain("TC-0105 건너뜀");
    expect(r.out).toContain("TC-0105  건너뜀(플로우 없음)");
    expect((await cli(["qa", "run", "demo-TC-0105"])).code).toBe(EXIT.noFlow);
  });

  it("6 시작하지 못함: 기기가 준비되지 않음, 다른 묶음이 도는 중", async () => {
    devices = [{ ...SIM, state: "shutdown" }];
    expect((await cli(["qa", "run", "demo-TC-0101"])).code).toBe(EXIT.error);
    devices = [SIM];
    const holding = cli(["qa", "run", "demo-TC-0109", "--json"]);
    await new Promise((r) => setTimeout(r, 200));
    const busy = await cli(["qa", "run", "demo-TC-0101"]);
    expect(busy.code).toBe(EXIT.error);
    expect(busy.err).toContain("다른 차례 실행이 진행 중이다(avocado-cli 0.1.0");
    const id = queue.busy()?.id ?? "";
    // 다른 터미널에서 status 로 보고 cancel 로 끈다
    const peek = await cli(["qa", "status", id, "--no-wait"]);
    expect(peek.code).toBe(EXIT.ok);
    expect(peek.out).toContain("진행 중");
    const c = await cli(["qa", "cancel", id]);
    expect(c.code).toBe(EXIT.ok);
    expect(c.out).toContain(`취소를 요청했다: ${id}`);
    expect((await holding).code).toBe(EXIT.canceled);
    const after = await cli(["qa", "status", id]);
    expect(after.code).toBe(EXIT.canceled);
  });

  it("options: 앱 버전, 테스트 케이스, 준비된 기기", async () => {
    const r = await cli(["qa", "options"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("앱 버전 9.9.9");
    expect(r.out).toContain("demo-TC-0101  ios  active  [smoke] 첫 화면");
    expect(r.out).toContain("SIM  ios simulator  iPhone 16");
    expect(JSON.parse((await cli(["qa", "options", "--json"])).out)).toMatchObject({ appVersion: "9.9.9" });
  });
});
