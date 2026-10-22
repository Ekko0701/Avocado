import type { Device } from "@qa/shared";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../db/database";
import { runCommand } from "../setup/command";
import { RunService } from "./run-service";

/**
 * 플로우 반복 안정성 측정(T-119 준비). 실제 Maestro·시뮬레이터로 같은 플로우를 N 번 재생하고 결과를 JSON 으로 남긴다. LLM 없음.
 * QA_STABILITY=1 QA_MAESTRO_BIN=… QA_JAVA_HOME=… QA_DEVICE_ID=… QA_STABILITY_FLOW=<플로우> QA_STABILITY_APP_ID=com.example.demo
 * QA_STABILITY_RUNS=20 QA_STABILITY_SECRET_KEY=DEMO_TEST_PASSWORD QA_STABILITY_OUT=out/stability/<이름>.json
 */
const enabled = process.env["QA_STABILITY"] === "1";

describe.skipIf(!enabled)("플로우 반복 안정성(실기기)", () => {
  it("N 번 재생해 통과·불안정·실패와 시간을 남긴다", async () => {
    const env = (k: string) => process.env[k] ?? "";
    const runsWanted = Number(env("QA_STABILITY_RUNS") || "20");
    const device: Device = { id: env("QA_DEVICE_ID"), platform: "ios", kind: "simulator", name: "QA Tool iPhone 17", osVersion: "27.0", state: "booted", managed: true, serial: null, locale: "ko_KR" };
    const dir = mkdtempSync(join(tmpdir(), "qa-stability-"));
    const db = AppDatabase.open(join(dir, "db.sqlite"));
    // 로컬 dev 서버(H2) 전용 테스트 값. 실행마다 새로 가입한다
    const secret = `qa-${Date.now().toString(36)}-Pw!`;
    const flow = resolve(env("QA_STABILITY_FLOW"));
    const service = new RunService({
      db,
      devices: { list: async () => ({ devices: [device] }) },
      builds: { get: () => { throw new Error("빌드 없이 돈다"); }, install: async () => ({ installed: true }) },
      tools: { maestroBin: () => env("QA_MAESTRO_BIN"), javaHome: () => env("QA_JAVA_HOME") },
      accountSecrets: () => ({ [env("QA_STABILITY_SECRET_KEY")]: secret }),
      redactionSecrets: () => [secret],
      evidenceRoot: join(dir, "evidence"),
      trustedFlowRoots: [dirname(flow)],
      home: homedir(),
      androidHome: join(homedir(), "Library", "Android", "sdk"),
      run: runCommand,
    });
    const rows: { n: number; status: string; flaky: boolean; attempts: number; ms: number; failure: string | null; load: number }[] = [];
    for (let n = 1; n <= runsWanted; n += 1) {
      const started = Date.now();
      const load = loadavg()[0] ?? 0;
      const run = await service.start({ app: "demo", flowPath: flow, deviceId: device.id, buildId: null }, { appId: env("QA_STABILITY_APP_ID") });
      await service.wait(run.id);
      const d = service.get(run.id);
      const failed = d.executions.find((e) => e.status !== "passed");
      rows.push({ n, status: d.status, flaky: d.flaky, attempts: d.attempts, ms: Date.now() - started, failure: failed?.failure ? `${failed.failure.kind}: ${failed.failure.message.slice(0, 160)}` : null, load: Math.round(load * 100) / 100 });
      console.log(JSON.stringify(rows.at(-1)));
    }
    db.close();
    const out = resolve(env("QA_STABILITY_OUT") || join(dir, "stability.json"));
    mkdirSync(dirname(out), { recursive: true });
    const sw = execFileSync("/usr/bin/sw_vers", ["-productVersion"]).toString().trim();
    writeFileSync(out, `${JSON.stringify({ flow: env("QA_STABILITY_FLOW"), device: device.name, macos: sw, at: new Date().toISOString(), rows }, null, 2)}\n`);
    expect(rows).toHaveLength(runsWanted);
  }, 3 * 60 * 60_000);
});
