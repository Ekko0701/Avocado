import type { Build, Device, RunSummary } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { runActivity } from "./activity";
import { RunStartFailure, startRunBatch, type RunBatchDeps } from "./run-batch";
import { RunQueue, type BatchMeta, type QueuedRun } from "./run-queue";
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
      summary: (id: string) =>
        ({ id, status: canceled.has(id) ? "canceled" : (opts.statusOf?.(id) ?? "passed"), failureMessage: opts.statusOf?.(id) === "error" ? "설치 실패" : null }) as RunSummary,
    },
  };
}
const item = (tcId: string): QueuedRun => ({ tcId, input: { app: "demo", flowPath: `/ws/${tcId}.yaml`, deviceId: "SIM", buildId: null }, options: {} });
const meta = (origin = "app"): BatchMeta => ({ origin, app: "demo", target: "ios", deviceId: "SIM", buildId: null, skipped: [] });
const tick = () => new Promise((r) => setTimeout(r, 0));
const idQueue = (runs: ConstructorParameters<typeof RunQueue>[0]) => {
  let n = 0;
  return new RunQueue(runs, () => `b${++n}`);
};

describe("차례 실행(RunQueue)", () => {
  it("시작 중에도 실행 중으로 보이고, 앞 실행이 끝나야 다음을 시작한다. 뒤쪽 시작 실패는 그 항목에 남기고 넘어간다", async () => {
    const f = fakeRuns({ failStart: "TC-0002", statusOf: (id) => (id === "run-2" ? "failed" : "passed") });
    const q = idQueue(f.runs);
    const batch = q.enqueue(meta(), [item("TC-0001"), item("TC-0002"), item("TC-0003")]);
    expect(batch).toMatchObject({ id: "b1", state: "running" });
    expect(q.status()).toMatchObject({ running: "TC-0001", pending: ["TC-0002", "TC-0003"], batchId: "b1", origin: "app" });
    await tick();
    f.release("run-1");
    await tick();
    await tick();
    f.release("run-2");
    await q.idle();
    expect(f.log).toEqual(["start /ws/TC-0001.yaml", "done run-1", "start /ws/TC-0003.yaml", "done run-2"]);
    expect(q.status()).toEqual({ pending: [], running: null, errors: ["TC-0002: 이 기기에서 이미 실행 중이다"], batchId: "b1", origin: "app" });
    expect(q.batch("b1")).toMatchObject({
      state: "done",
      items: [
        { tcId: "TC-0001", runId: "run-1", status: "passed" },
        { tcId: "TC-0002", runId: null, status: "error", failureMessage: "이 기기에서 이미 실행 중이다" },
        { tcId: "TC-0003", runId: "run-2", status: "failed" },
      ],
    });
    expect(q.busy()).toBeNull();
  });

  it("도는 중에는 새 묶음을 받지 않는다. 끝나면 다음 묶음은 새 id 를 받고 끝난 묶음도 id 로 읽힌다", async () => {
    const f = fakeRuns();
    const q = idQueue(f.runs);
    q.enqueue(meta("avocado-cli 0.1.0"), [item("TC-0001")]);
    expect(() => q.enqueue(meta(), [item("TC-0009")])).toThrow("avocado-cli 0.1.0");
    await tick();
    f.release("run-1");
    await q.idle();
    expect(q.enqueue(meta(), [item("TC-0002")]).id).toBe("b2");
    expect(q.batch("b1")?.state).toBe("done");
    expect(q.batch("nope")).toBeNull();
  });

  it("첫 실행이 시작하지 못하거나 오류로 끝나면 나머지를 돌리지 않고 취소로 적는다", async () => {
    const f = fakeRuns({ failStart: "TC-0001" });
    const q = idQueue(f.runs);
    q.enqueue(meta(), [item("TC-0001"), item("TC-0002")]);
    await q.idle();
    expect(f.started).toEqual([]);
    expect(q.batch("b1")?.items.map((i) => i.status)).toEqual(["error", "canceled"]);

    const g = fakeRuns({ statusOf: (id) => (id === "run-1" ? "error" : "passed") });
    const q2 = idQueue(g.runs);
    q2.enqueue(meta(), [item("TC-0001"), item("TC-0002")]);
    await tick();
    g.release("run-1");
    await q2.idle();
    expect(g.started).toHaveLength(1);
    expect(q2.status().errors[0]).toContain("첫 실행이 오류로 끝나");
    expect(q2.batch("b1")?.items[1]).toMatchObject({ status: "canceled", failureMessage: "첫 실행이 오류로 끝나 돌리지 않았다" });
  });

  it("취소는 그 묶음 id 로만: 다른 id 는 아무것도 하지 않고, 맞는 id 는 남은 것을 버리고 진행 중인 실행을 취소한다", async () => {
    const f = fakeRuns();
    const q = idQueue(f.runs);
    q.enqueue(meta(), [item("TC-0001"), item("TC-0002")]);
    await tick();
    expect(q.cancel("other")).toBeNull();
    expect(f.log).toEqual(["start /ws/TC-0001.yaml"]);
    q.cancel("b1");
    await q.idle();
    expect(f.log).toEqual(["start /ws/TC-0001.yaml", "cancel run-1", "done run-1"]);
    expect(q.batch("b1")?.items.map((i) => i.status)).toEqual(["canceled", "canceled"]);

    // 시작 중에 비워도 시작되는 대로 취소한다
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const g = fakeRuns({ startGate: gate });
    const q2 = idQueue(g.runs);
    q2.enqueue(meta(), [item("TC-0001"), item("TC-0002")]);
    q2.clear();
    open();
    await q2.idle();
    expect(g.log).toEqual(["start /ws/TC-0001.yaml", "cancel run-1", "done run-1"]);
    expect(q2.status()).toMatchObject({ pending: [], running: null, errors: [] });
  });

  it("상태 기다리기: 바뀌면 바로, 아니면 시간이 지나서 돌아온다. 끝난 묶음은 기다리지 않는다", async () => {
    const f = fakeRuns();
    const q = idQueue(f.runs);
    q.enqueue(meta(), [item("TC-0001")]);
    await tick();
    const t0 = Date.now();
    expect((await q.waitForChange("b1", 30))?.state).toBe("running");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const waiting = q.waitForChange("b1", 10_000);
    f.release("run-1");
    expect((await waiting)?.items[0]?.status).toBe("passed");
    await q.idle();
    const t1 = Date.now();
    expect((await q.waitForChange("b1", 10_000))?.state).toBe("done");
    expect(Date.now() - t1).toBeLessThan(100);
  });

  it("실행 중 검사: 묶음의 항목과 항목 사이(진행 중인 실행 0)에도 실행 중이다", async () => {
    let activeRuns = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const f = fakeRuns({ startGate: gate });
    const q = idQueue(f.runs);
    const busy = runActivity({ activeCount: () => activeRuns }, q);
    expect(busy()).toBeNull();
    q.enqueue(meta("avocado-cli 0.1.0"), [item("TC-0001"), item("TC-0002")]);
    expect(busy()).toContain("avocado-cli 0.1.0");
    open();
    await tick();
    f.release("run-1");
    await tick();
    expect(busy()).toContain("avocado-cli 0.1.0");
    q.cancel("b1");
    await q.idle();
    expect(busy()).toBeNull();
    activeRuns = 1;
    expect(busy()).toBe("플로우 실행이 진행 중이다");
  });
});

const device = (over: Partial<Device> = {}): Device => ({ id: "SIM", platform: "ios", kind: "simulator", name: "iPhone 16", osVersion: "18.0", state: "booted", managed: true, serial: null, locale: null, ...over });
type Plan = NonNullable<ReturnType<RunBatchDeps["workspace"]["runPlan"]>>;

function batchDeps(over: { plan?: (target: "ios" | "android") => Plan | null; devices?: Device[]; targets?: ("ios" | "android")[]; builds?: Record<string, Build>; ios?: string | null; busy?: string | null } = {}) {
  const f = fakeRuns();
  const queue = idQueue(f.runs);
  const plans: { target: string; tcIds?: readonly string[]; tag?: string }[] = [];
  const deps: RunBatchDeps = {
    workspace: {
      runPlan: (input) => {
        plans.push({ target: input.target, ...(input.tcIds ? { tcIds: input.tcIds } : {}), ...(input.tag ? { tag: input.tag } : {}) });
        return over.plan ? over.plan(input.target) : { known: true, apps: ["demo"], appId: "com.example.demo", flows: [{ tcId: "TC-0101", path: `/ws/${input.target}/TC-0101.yaml`, envKeys: ["DEMO_TEST_PASSWORD"] }], missing: [], noFlow: [] };
      },
      appTargets: () => over.targets ?? ["ios"],
    },
    builds: {
      get: (id) => {
        const b = over.builds?.[id];
        if (!b) throw new Error("없음");
        return b;
      },
    },
    devices: { list: () => Promise.resolve({ devices: over.devices ?? [device()] }) },
    queue,
    iosDeviceProblem: () => Promise.resolve(over.ios ?? null),
    deviceBusy: () => over.busy ?? null,
  };
  return { f, queue, deps, plans };
}

async function startError(deps: RunBatchDeps, input: Parameters<typeof startRunBatch>[1]): Promise<RunStartFailure> {
  try {
    await startRunBatch(deps, input, { via: "mcp", client: "avocado-cli 0.1.0" });
  } catch (error) {
    if (error instanceof RunStartFailure) return error;
    throw error;
  }
  throw new Error("거절하지 않았다");
}

describe("실행 묶음 시작(startRunBatch)", () => {
  it("밖에서 시작한 묶음은 trigger mcp, 실행 화면은 manual 로 기록한다", async () => {
    const t = batchDeps();
    const batch = await startRunBatch(t.deps, { app: "demo", tcIds: ["TC-0101"] }, { via: "mcp", client: "avocado-cli 0.1.0" });
    expect(batch).toMatchObject({ origin: "avocado-cli 0.1.0", target: "ios", deviceId: "SIM", items: [{ tcId: "TC-0101", status: "running" }] });
    await tick();
    t.f.release("run-1");
    await t.queue.idle();
    expect(t.f.started[0]?.options).toEqual({ appId: "com.example.demo", envKeys: ["DEMO_TEST_PASSWORD"], trigger: "mcp" });

    // 클라이언트가 이름을 app 으로 대도 MCP 로 기록한다
    const spoof = batchDeps();
    expect((await startRunBatch(spoof.deps, { app: "demo", tcIds: ["TC-0101"] }, { via: "mcp", client: "app" })).origin).toBe("mcp:app");
    await tick();
    spoof.f.release("run-1");
    await spoof.queue.idle();
    expect(spoof.f.started[0]?.options.trigger).toBe("mcp");

    const u = batchDeps();
    await startRunBatch(u.deps, { app: "demo", target: "ios", tcIds: ["TC-0101"], deviceId: "SIM" }, { via: "app" });
    await tick();
    u.f.release("run-1");
    await u.queue.idle();
    expect(u.f.started[0]?.options.trigger).toBe("manual");
  });

  it("기기 고르기: 0대·여러 대는 거절, 1대는 그 기기, 실기기와 Android 는 그 플랫폼, 준비 안 된 iPhone 은 거절", async () => {
    expect((await startError(batchDeps({ devices: [device({ state: "shutdown" })] }).deps, { app: "demo", tcIds: ["TC-0101"] })).code).toBe("device_not_ready");
    const two = await startError(batchDeps({ devices: [device(), device({ id: "SIM2", name: "iPhone 15" })] }).deps, { app: "demo", tcIds: ["TC-0101"] });
    expect(two).toMatchObject({ code: "device_ambiguous", candidates: ["SIM (iPhone 16)", "SIM2 (iPhone 15)"] });

    const phone = device({ id: "R58", platform: "android", kind: "real", name: "Galaxy", serial: "R58" });
    const android = batchDeps({ devices: [device(), phone], targets: ["ios", "android"] });
    const b = await startRunBatch(android.deps, { app: "demo", tcIds: ["TC-0101"], deviceId: "R58" }, { via: "mcp", client: "cli" });
    expect(b).toMatchObject({ target: "android", deviceId: "R58" });
    expect(android.plans.map((p) => p.target)).toEqual(["ios", "android"]);

    const iphone = device({ id: "00008110", kind: "real", name: "iPhone" });
    expect(await startError(batchDeps({ devices: [iphone], ios: "iPhone 이 준비되지 않았다: 잠금 — 잠겨 있다" }).deps, { app: "demo", tcIds: ["TC-0101"] })).toMatchObject({
      code: "device_not_ready",
      message: "iPhone 이 준비되지 않았다: 잠금 — 잠겨 있다",
    });
    expect(await startError(batchDeps({ busy: "플로우 만들기가 이 기기를 쓰고 있다" }).deps, { app: "demo", tcIds: ["TC-0101"] })).toMatchObject({ code: "device_not_ready", message: "플로우 만들기가 이 기기를 쓰고 있다" });
    expect((await startError(batchDeps().deps, { app: "demo", target: "android", tcIds: ["TC-0101"], deviceId: "SIM" })).code).toBe("device_not_ready");
    expect((await startError(batchDeps().deps, { app: "demo", tcIds: ["TC-0101"], deviceId: "GONE" })).code).toBe("device_not_ready");
  });

  it("거절 코드: 워크스페이스·앱·TC·플로우·빌드·차례 실행", async () => {
    const plan = (p: Partial<Plan>) => () => ({ known: true, apps: ["demo"], appId: null, flows: [], missing: [], noFlow: [], ...p });
    expect((await startError(batchDeps({ plan: () => null }).deps, { app: "demo", tcIds: ["TC-0101"] })).code).toBe("workspace_not_connected");
    expect(await startError(batchDeps({ plan: plan({ known: false, apps: ["demo", "sample"] }) }).deps, { app: "nope", tcIds: ["TC-0101"] })).toMatchObject({ code: "unknown_app", candidates: ["demo", "sample"] });
    expect(await startError(batchDeps({ plan: plan({ missing: ["TC-9999"] }) }).deps, { app: "demo", tcIds: ["TC-9999"] })).toMatchObject({ code: "unknown_testcase" });
    expect(await startError(batchDeps({ plan: plan({}) }).deps, { app: "demo", tag: "nothing" })).toMatchObject({ code: "unknown_testcase" });
    expect(await startError(batchDeps({ plan: plan({ noFlow: ["TC-0102"] }) }).deps, { app: "demo", tcIds: ["TC-0102"] })).toMatchObject({ code: "no_flow", candidates: ["TC-0102"] });
    // 타깃을 주면 플로우 문제를 기기보다 먼저 알린다
    expect((await startError(batchDeps({ plan: plan({ noFlow: ["TC-0102"] }), devices: [] }).deps, { app: "demo", target: "ios", tcIds: ["TC-0102"], deviceId: "GONE" })).code).toBe("no_flow");
    expect((await startError(batchDeps().deps, { app: "demo", tcIds: ["TC-0101"], buildId: "gone" })).code).toBe("bad_build");
    const android = { id: "b1", app: "demo", target: "android", appId: "com.example.demo" } as Build;
    expect((await startError(batchDeps({ builds: { b1: android } }).deps, { app: "demo", tcIds: ["TC-0101"], buildId: "b1" })).code).toBe("bad_build");

    const t = batchDeps();
    await startRunBatch(t.deps, { app: "demo", tcIds: ["TC-0101"] }, { via: "app" });
    expect(await startError(t.deps, { app: "demo", tcIds: ["TC-0101"] })).toMatchObject({ code: "queue_busy", message: expect.stringContaining("실행 화면") as unknown });
  });

  it("태그 실행: 플로우가 없는 TC 는 조용히 빼지 않고 skipped 에 적는다. 빌드는 모두에 기록하고 설치는 첫 실행만", async () => {
    const build = { id: "b1", app: "demo", target: "ios", appId: "com.example.demo.qa" } as Build;
    const t = batchDeps({
      builds: { b1: build },
      plan: () => ({
        known: true,
        apps: ["demo"],
        appId: "com.example.demo",
        flows: [
          { tcId: "TC-0101", path: "/ws/a.yaml", envKeys: ["DEMO_TEST_PASSWORD"] },
          { tcId: "TC-0103", path: "/ws/c.yaml", envKeys: [] },
        ],
        missing: [],
        noFlow: ["TC-0102"],
      }),
    });
    const batch = await startRunBatch(t.deps, { app: "demo", tag: "smoke", buildId: "b1" }, { via: "mcp", client: "cli" });
    expect(batch.skipped).toEqual([{ tcId: "TC-0102", reason: "no_flow" }]);
    expect(t.plans[0]).toMatchObject({ tag: "smoke" });
    await tick();
    t.f.release("run-1");
    await tick();
    await tick();
    t.f.release("run-2");
    await t.queue.idle();
    expect(t.f.started.map((s) => [s.input.buildId, s.options])).toEqual([
      ["b1", { skipInstall: false, envKeys: ["DEMO_TEST_PASSWORD"], trigger: "mcp" }],
      ["b1", { skipInstall: true, envKeys: [], trigger: "mcp" }],
    ]);
  });

  it("실행 화면의 IPC 도 같은 입구를 지나고 차례 실행 상태를 돌려준다", async () => {
    const t = batchDeps();
    const handlers = createWorkspaceRunHandlers(t.deps);
    const status = await handlers["runs:startFromWorkspace"]({ app: "demo", target: "ios", tcId: "TC-0101", deviceId: "SIM", buildId: null });
    expect(status).toMatchObject({ running: "TC-0101", origin: "app" });
    await expect(async () => handlers["runs:startFromWorkspace"]({ app: "demo", target: "ios", tcId: "TC-0101", deviceId: "SIM", buildId: null })).rejects.toThrow("다른 차례 실행이 진행 중이다");
    expect(handlers["runs:clearQueue"](undefined)).toMatchObject({ running: "TC-0101" });
    await t.queue.idle();
    expect(handlers["runs:queue"](undefined)).toMatchObject({ running: null, pending: [] });
  });
});
