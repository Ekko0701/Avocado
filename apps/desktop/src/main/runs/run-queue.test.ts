import type { Build, RunSummary } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { RunQueue, type QueuedRun } from "./run-queue";
import { createWorkspaceRunHandlers } from "./workspace-run-handlers";

function fakeRuns(opts: { failStart?: string; statusOf?: (id: string) => RunSummary["status"]; startGate?: Promise<void> } = {}) {
  const log: string[] = [];
  const started: { input: QueuedRun["input"]; options: QueuedRun["options"] }[] = [];
  const gates = new Map<string, () => void>();
  const canceled = new Set<string>();
  let n = 0;
  return {
    log,
    started,
    release: (id: string) => gates.get(id)?.(),
    runs: {
      start: async (input: QueuedRun["input"], options: QueuedRun["options"]) => {
        await opts.startGate;
        if (opts.failStart && input.flowPath.includes(opts.failStart)) throw new Error("이 기기에서 이미 실행 중이다");
        const id = `run-${++n}`;
        started.push({ input, options });
        log.push(`start ${input.flowPath}`);
        return { id } as RunSummary;
      },
      wait: (id: string) =>
        new Promise<void>((r) => {
          const done = () => {
            log.push(`done ${id}`);
            r();
          };
          // 실제 RunService 처럼 이미 취소된 실행은 바로 끝난다
          if (canceled.has(id)) done();
          else gates.set(id, done);
        }),
      cancel: (id: string) => {
        log.push(`cancel ${id}`);
        canceled.add(id);
        gates.get(id)?.();
        return { id } as RunSummary;
      },
      summary: (id: string) => ({ id, status: opts.statusOf?.(id) ?? "passed", failureMessage: "설치 실패" }) as RunSummary,
    },
  };
}
const item = (label: string): QueuedRun => ({ label, input: { app: "demo", flowPath: `/ws/${label}.yaml`, deviceId: "SIM", buildId: null }, options: {} });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("차례 실행(RunQueue)", () => {
  it("시작 중에도 실행 중으로 보이고, 앞 실행이 끝나야 다음을 시작한다. 뒤쪽 시작 실패는 기록하고 넘어간다", async () => {
    const f = fakeRuns({ failStart: "TC-0002" });
    const q = new RunQueue(f.runs);
    q.enqueue([item("TC-0001"), item("TC-0002"), item("TC-0003")]);
    expect(q.status()).toMatchObject({ running: "TC-0001", pending: ["TC-0002", "TC-0003"] });
    await tick();
    expect(() => q.enqueue([item("TC-0009")])).toThrow("이미 차례 실행 중");
    f.release("run-1");
    await tick();
    await tick();
    f.release("run-2");
    await q.idle();
    expect(f.log).toEqual(["start /ws/TC-0001.yaml", "done run-1", "start /ws/TC-0003.yaml", "done run-2"]);
    expect(q.status()).toEqual({ pending: [], running: null, errors: ["TC-0002: 이 기기에서 이미 실행 중이다"] });
  });

  it("TC 하나가 시작하지 못하면 오류가 상태에 남는다(화면이 기다렸다가 보여 준다)", async () => {
    const f = fakeRuns({ failStart: "TC-0001" });
    const q = new RunQueue(f.runs);
    q.enqueue([item("TC-0001"), item("TC-0002")]);
    expect(q.status().running).toBe("TC-0001");
    await q.idle();
    // 첫 실행이 시작하지 못하면 나머지는 돌리지 않는다
    expect(q.status()).toEqual({ pending: [], running: null, errors: ["TC-0001: 이 기기에서 이미 실행 중이다"] });
    expect(f.started).toEqual([]);
  });

  it("첫 실행이 오류(설치 실패 등)로 끝나면 나머지를 돌리지 않는다", async () => {
    const f = fakeRuns({ statusOf: (id) => (id === "run-1" ? "error" : "passed") });
    const q = new RunQueue(f.runs);
    q.enqueue([item("TC-0001"), item("TC-0002")]);
    await tick();
    f.release("run-1");
    await q.idle();
    expect(f.started).toHaveLength(1);
    expect(q.status().errors[0]).toContain("첫 실행이 오류로 끝나");
  });

  it("비우면 남은 것을 버리고, 실행 중이거나 시작 중인 실행을 취소한다", async () => {
    const f = fakeRuns();
    const q = new RunQueue(f.runs);
    q.enqueue([item("TC-0001"), item("TC-0002")]);
    await tick();
    q.clear();
    await q.idle();
    expect(f.log).toEqual(["start /ws/TC-0001.yaml", "cancel run-1", "done run-1"]);

    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const g = fakeRuns({ startGate: gate });
    const q2 = new RunQueue(g.runs);
    q2.enqueue([item("TC-0001"), item("TC-0002")]);
    q2.clear(); // 아직 시작 중
    open();
    await q2.idle();
    expect(g.log).toEqual(["start /ws/TC-0001.yaml", "cancel run-1", "done run-1"]);
    expect(q2.status()).toEqual({ pending: [], running: null, errors: [] });
  });

  it("태그 실행: 빌드는 모든 실행에 기록하고 설치는 첫 실행에서만, 빌드가 없으면 app.yaml 의 앱 id", async () => {
    const f = fakeRuns();
    const queue = new RunQueue(f.runs);
    const build = { id: "b1", app: "demo", target: "ios", appId: "com.example.demo.qa" } as Build;
    const handlers = createWorkspaceRunHandlers({
      workspace: { flowsToRun: () => ({ appId: "com.example.demo", flows: [{ tcId: "TC-0101", path: "/ws/a.yaml" }, { tcId: "TC-0102", path: "/ws/b.yaml" }] }) },
      builds: { get: () => build },
      queue,
    });
    await handlers["runs:startFromWorkspace"]({ app: "demo", target: "ios", tag: "smoke", deviceId: "SIM", buildId: "b1" });
    await tick();
    f.release("run-1");
    await tick();
    await tick();
    f.release("run-2");
    await queue.idle();
    expect(f.started.map((s) => [s.input.buildId, s.options])).toEqual([
      ["b1", { skipInstall: false }],
      ["b1", { skipInstall: true }],
    ]);

    const noBuild = fakeRuns();
    const q2 = new RunQueue(noBuild.runs);
    const h2 = createWorkspaceRunHandlers({ workspace: { flowsToRun: () => ({ appId: "com.example.demo", flows: [{ tcId: "TC-0101", path: "/ws/a.yaml" }] }) }, builds: { get: () => build }, queue: q2 });
    await h2["runs:startFromWorkspace"]({ app: "demo", target: "ios", tcId: "TC-0101", deviceId: "SIM", buildId: null });
    await tick();
    noBuild.release("run-1");
    await q2.idle();
    expect(noBuild.started[0]?.options).toEqual({ appId: "com.example.demo" });
    await expect(async () => h2["runs:startFromWorkspace"]({ app: "sample", target: "ios", tcId: "TC-0002", deviceId: "SIM", buildId: "b1" })).rejects.toThrow("용이 아니다");
  });
});
