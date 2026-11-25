/**
 * 실제 iPhone 으로 iOS 실기기 재생 전체 경로를 확인한다(ADR 0034). 화면 없이 main 서비스만 쓴다.
 * 고정 버전 agent-device 설치(npm, SHA-256) → 준비 점검 → 러너 서명·설치 → 설정 앱 플로우 재생(통과·실패) → 가린 증적.
 *
 *   QA_REAL_IOS_DEVICE=1 QA_IOS_DEVICE_ID=<UDID> QA_IOS_TEAM=<팀 ID> pnpm --filter @qa/desktop exec vitest run src/main/runs/ios-device.real.test.ts
 *
 * 사람이 할 일: iPhone 을 케이블로 연결하고 잠금을 풀어 둔다. iPhone 개발자 모드와 Mac DevToolsSecurity 가 켜져 있어야 한다.
 * 결과(앱 데이터 폴더)는 out/real/ios-device 에 남긴다.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findSecretResidue } from "@qa/evidence";
import { AppDatabase } from "../db/database";
import { AgentDevice } from "../devices/agent-device";
import { IosDeviceService } from "../devices/ios-device-service";
import { runToLog } from "../process/run-to-log";
import { runCommand } from "../setup/command";
import { ToolInstaller } from "../setup/installer";
import { DEFAULT_TOOLS } from "../setup/tools";
import { RunService } from "./run-service";

const enabled = process.env["QA_REAL_IOS_DEVICE"] === "1";
const UDID = process.env["QA_IOS_DEVICE_ID"] ?? "";
const TEAM = process.env["QA_IOS_TEAM"] ?? "";
const FAKE = "fixture-account-7731";
const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

describe.skipIf(!enabled)("iOS 실기기 재생(실제 iPhone)", () => {
  it("도구 설치 → 점검·러너 → 통과·실패 플로우", { timeout: 30 * 60_000 }, async () => {
    const out = join(ROOT, "out", "real", "ios-device");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const electron = createRequire(import.meta.url)("electron") as unknown as string;

    const installer = new ToolInstaller({ toolsDir: join(out, "tools"), tools: DEFAULT_TOOLS, run: runCommand });
    const agentDevice = new AgentDevice({ entry: () => installer.agentDeviceEntry(), nodeBin: electron, root: join(out, "agent-device"), home: process.env["HOME"] ?? "", run: runCommand, runToLog });
    const ios = new IosDeviceService({
      run: runCommand,
      agentDevice,
      signingTeam: () => TEAM,
      toolInstalled: () => installer.status("agent-device").installed,
      installTool: async () => {
        await installer.install("agent-device");
      },
    });

    const teams = await ios.signingTeams();
    expect(teams.map((t) => t.id)).toContain(TEAM);
    const readiness = await ios.check(UDID, true);
    writeFileSync(join(out, "readiness.json"), JSON.stringify(readiness, null, 2));
    expect(readiness.checks.filter((c) => !c.ok)).toEqual([]);
    expect(installer.status("agent-device")).toMatchObject({ installed: true, version: DEFAULT_TOOLS["agent-device"].version });

    const flows = join(out, "flows");
    mkdirSync(flows, { recursive: true });
    for (const name of ["ios-pass", "ios-fail"]) {
      // 원본 픽스처 플로우 그대로(캡처 이름에 .png 없음). 앱이 사본에서 붙인다
      writeFileSync(join(flows, `${name}.yaml`), readFileSync(join(ROOT, "packages", "evidence", "fixtures", "flows", `${name}.yaml`), "utf8"));
    }
    const db = AppDatabase.open(join(out, "db.sqlite"));
    try {
      const devices = { list: async () => ({ devices: await ios.list(), androidAvailable: false }) };
      const runs = new RunService({
        db,
        devices,
        builds: {
          get: () => {
            throw new Error("빌드 없음");
          },
          install: () => Promise.reject(new Error("설치하면 안 된다")),
        },
        tools: { maestroBin: () => null, javaHome: () => null },
        accountSecrets: () => ({ QA_FIXTURE_ACCOUNT_ID: FAKE }),
        accountKeys: () => ["QA_FIXTURE_ACCOUNT_ID"],
        redactionSecrets: () => [FAKE],
        evidenceRoot: join(out, "evidence"),
        trustedFlowRoots: [flows],
        home: process.env["HOME"] ?? "",
        androidHome: "/nonexistent",
        run: runCommand,
        retries: 0,
        iosDevice: {
          agentDevice,
          signingTeam: () => TEAM,
          check: (id) => ios.check(id, false),
          isAppInstalled: (id, bundleId) => ios.isAppInstalled(id, bundleId),
          screenshot: (id, dest) => ios.screenshot(id, dest),
        },
      });
      const results: Record<string, unknown> = {};
      for (const name of ["ios-pass", "ios-fail"]) {
        const run = await runs.start({ app: "sample", flowPath: join(flows, `${name}.yaml`), deviceId: UDID, buildId: null });
        await runs.wait(run.id);
        const detail = runs.get(run.id);
        results[name] = { status: detail.status, failureMessage: detail.failureMessage, steps: detail.executions[0]?.steps.map((s) => [s.command, s.status, s.screenshot, s.failureScreenshot]), warnings: detail.executions[0]?.warnings };
        expect(findSecretResidue(join(out, "evidence", run.id), [FAKE]).filter((r) => r.path.includes("/redacted/"))).toEqual([]);
      }
      writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
      expect(results["ios-pass"]).toMatchObject({ status: "passed" });
      expect(results["ios-fail"]).toMatchObject({ status: "failed" });
    } finally {
      db.close();
    }
  });
});
