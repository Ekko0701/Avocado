import type { Build, Device, RunBatch, RunOptions, RunStartErrorCode, StartRunsInput, TestcaseList } from "@qa/shared";
import { notReady } from "../devices/ready";
import { RunQueueBusyError, type RunQueue } from "./run-queue";

/** 실행 묶음을 시작하지 않은 이유(ADR 0035). code 로 CLI 종료 코드가 정해진다 */
export class RunStartFailure extends Error {
  constructor(
    readonly code: RunStartErrorCode,
    message: string,
    readonly candidates?: string[],
  ) {
    super(message);
  }
}

type Plan = { known: boolean; apps: string[]; appId: string | null; flows: { tcId: string; path: string; envKeys: string[] }[]; missing: string[]; noFlow: string[] };

export interface RunBatchDeps {
  workspace: {
    runPlan(input: { app: string; target: "ios" | "android"; tcIds?: readonly string[]; tag?: string }): Plan | null;
    appTargets(app: string): ("ios" | "android")[];
  };
  builds: { get(id: string): Build };
  devices: { list(): Promise<{ devices: Device[] }> };
  queue: RunQueue;
  /** iPhone 준비 점검. 준비됐으면 null, 아니면 이유 */
  iosDeviceProblem(deviceId: string): Promise<string | null>;
  /** 이 기기를 다른 작업(플로우 만들기, 플로우 파일 실행)이 쓰고 있으면 그 이유 */
  deviceBusy(device: Device): string | null;
}

const label = (d: Device) => `${d.id} (${d.name})`;

/**
 * 실행 화면(IPC)과 밖의 MCP 클라이언트가 같이 부르는 입구(ADR 0035 결정 2).
 * 큐에 넣기 전에 앱·TC·플로우·빌드·기기를 보고, 안 되면 RunStartFailure 로 바로 거절한다.
 * MCP 로 시작한 실행은 trigger "mcp" 로 기록해 자동 화면 판정에서 뺀다(결정 7)
 */
export type RunOrigin = { via: "app" } | { via: "mcp"; client: string };

export async function startRunBatch(deps: RunBatchDeps, input: StartRunsInput, from: RunOrigin): Promise<RunBatch> {
  // 기록 방식은 입구로 정한다. 클라이언트가 이름을 "app" 으로 대도 실행 화면 시작이 되지 않는다
  const origin = from.via === "app" ? "app" : from.client === "app" ? "mcp:app" : from.client;
  const running = deps.queue.busy();
  if (running) throw new RunStartFailure("queue_busy", `다른 차례 실행이 진행 중이다(${running.origin === "app" ? "실행 화면" : running.origin}, ${running.id}). 끝나거나 비운 뒤 다시 시작한다`);

  const probe = deps.workspace.runPlan({ app: input.app, target: input.target ?? "ios", ...pick(input) });
  if (!probe) throw new RunStartFailure("workspace_not_connected", "워크스페이스가 연결되지 않았다. 앱의 워크스페이스 화면에서 연결하거나 받는다");
  if (!probe.known) throw new RunStartFailure("unknown_app", `워크스페이스에 없는 앱이다: ${input.app}`, probe.apps);

  // 인자 문제(없는 TC, 플로우 없음)는 기기와 상관없이 알 수 있으니 먼저 알린다. 타깃을 주지 않았으면 플로우 확인은 기기를 고른 뒤에 한다
  if (probe.missing.length > 0) throw new RunStartFailure("unknown_testcase", `${input.app} 에 없는 테스트 케이스다(형식 오류 포함): ${probe.missing.join(", ")}`);
  if (input.target) checkFlows(probe, { ...input, target: input.target });
  const device = await pickDevice(deps, input);
  const target = device.platform;
  const plan = target === (input.target ?? "ios") ? probe : deps.workspace.runPlan({ app: input.app, target, ...pick(input) });
  if (!plan) throw new RunStartFailure("workspace_not_connected", "워크스페이스가 연결되지 않았다");
  checkFlows(plan, { ...input, target });

  let build: Build | null = null;
  if (input.buildId) {
    try {
      build = deps.builds.get(input.buildId);
    } catch {
      throw new RunStartFailure("bad_build", `빌드를 찾지 못했다: ${input.buildId}`);
    }
    if (build.app !== input.app || build.target !== target) throw new RunStartFailure("bad_build", `빌드가 ${input.app} ${target} 용이 아니다(${build.app} ${build.target})`);
  }

  const trigger = from.via === "app" ? "manual" : "mcp";
  try {
    // 빌드는 모든 실행에 기록하고(증적에 어떤 빌드인지 남는다) 설치는 첫 실행에서만 한다.
    // 빌드가 없으면 app.yaml 의 앱 id 로 기기에 설치된 앱을 돌린다. 계정 값은 그 TC 역할의 키만 넘긴다
    return deps.queue.enqueue(
      { origin, app: input.app, target, deviceId: device.id, buildId: build?.id ?? null, skipped: plan.noFlow.map((tcId) => ({ tcId, reason: "no_flow" as const })) },
      plan.flows.map((f, i) => ({
        tcId: f.tcId,
        input: { app: input.app, flowPath: f.path, deviceId: device.id, buildId: build?.id ?? null },
        options: { ...(build ? { skipInstall: i > 0 } : plan.appId ? { appId: plan.appId } : {}), envKeys: f.envKeys, trigger },
      })),
    );
  } catch (error) {
    if (error instanceof RunQueueBusyError) throw new RunStartFailure("queue_busy", error.message);
    throw error;
  }
}

function checkFlows(plan: Plan, input: StartRunsInput & { target: "ios" | "android" }): void {
  if (plan.flows.length === 0 && plan.noFlow.length === 0) throw new RunStartFailure("unknown_testcase", `${input.app} 에 태그 ${input.tag ?? ""} 인 active 테스트 케이스가 없다`);
  if (plan.flows.length === 0) throw new RunStartFailure("no_flow", `${plan.noFlow.join(", ")} 의 ${input.target} 플로우가 없다. 앱의 플로우 만들기에서 먼저 만든다`, plan.noFlow);
}

function pick(input: StartRunsInput): { tcIds?: readonly string[]; tag?: string } {
  return input.tcIds ? { tcIds: input.tcIds } : { tag: input.tag ?? "" };
}

/** 기기를 주면 그 기기, 아니면 그 앱 타깃에서 준비된 기기가 하나일 때만 그 기기(ADR 0035 결정 5) */
async function pickDevice(deps: RunBatchDeps, input: StartRunsInput): Promise<Device> {
  const all = (await deps.devices.list()).devices;
  const targets = input.target ? [input.target] : deps.workspace.appTargets(input.app);
  const ready = all.filter((d) => d.state === "booted" && targets.includes(d.platform));
  let device: Device;
  if (input.deviceId) {
    const found = all.find((d) => d.id === input.deviceId || (d.serial !== null && d.serial === input.deviceId));
    if (!found) throw new RunStartFailure("device_not_ready", `기기를 찾지 못했다: ${input.deviceId}`, ready.map(label));
    if (input.target && found.platform !== input.target) throw new RunStartFailure("device_not_ready", `${found.name} 은 ${input.target} 기기가 아니다`, ready.map(label));
    device = found;
  } else if (ready.length === 1 && ready[0]) {
    device = ready[0];
  } else if (ready.length === 0) {
    throw new RunStartFailure("device_not_ready", `준비된 ${targets.join("·") || "기기"} 기기가 없다. 앱의 기기 화면에서 먼저 준비한다`);
  } else {
    throw new RunStartFailure("device_ambiguous", `준비된 기기가 여럿이다. 기기를 고른다`, ready.map(label));
  }
  if (device.state !== "booted") throw new RunStartFailure("device_not_ready", notReady(device));
  if (device.platform === "android" && !device.serial) throw new RunStartFailure("device_not_ready", `Android serial 을 알 수 없다: ${device.name}`);
  const busy = deps.deviceBusy(device);
  if (busy) throw new RunStartFailure("device_not_ready", busy);
  if (device.platform === "ios" && device.kind === "real") {
    const problem = await deps.iosDeviceProblem(device.id);
    if (problem) throw new RunStartFailure("device_not_ready", problem);
  }
  return device;
}

/** run_options 의 목록. 형식 문제가 있는 TC 는 화면처럼 빼고, 기기는 준비된 것만 넣는다 */
export async function collectRunOptions(deps: {
  appVersion: string;
  workspace: { connected(): boolean; testcases(): Promise<TestcaseList> };
  devices: { list(): Promise<{ devices: Device[] }> };
  builds: { list(): Build[] };
  busy(): string | null;
}): Promise<RunOptions> {
  const connected = deps.workspace.connected();
  const list = connected ? await deps.workspace.testcases() : null;
  const isTarget = (t: string): t is "ios" | "android" => t === "ios" || t === "android";
  return {
    appVersion: deps.appVersion,
    workspaceConnected: connected,
    apps: (list?.apps ?? []).map((a) => ({
      app: a.app,
      testcases: (list?.testcases ?? [])
        .filter((t) => t.app === a.app && t.valid)
        .map((t) => ({ id: t.id, title: t.title ?? "", tags: t.tags, status: t.status ?? "", flows: t.flows.filter(isTarget) })),
    })),
    devices: (await deps.devices.list()).devices.filter((d) => d.state === "booted").map((d) => ({ id: d.id, name: d.name, platform: d.platform, kind: d.kind })),
    builds: deps.builds.list().map((b) => ({ id: b.id, app: b.app, target: b.target, label: b.label ?? `${b.appId} ${b.version} (${b.buildNumber})`, createdAt: b.createdAt })),
    busy: deps.busy(),
  };
}
