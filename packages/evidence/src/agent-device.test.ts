import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanMessage, parseAgentDeviceExecution, parseKeyValues } from "./agent-device";
import { EvidenceParseError } from "./model";
import { parseExecution } from "./parse";
import { findSecretResidue, redactExecutionDir } from "./redact";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const FAKE = "fixture-account-7731";
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ad-evidence-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseAgentDeviceExecution", () => {
  it("통과 실행의 스텝·캡처·시간을 읽는다", () => {
    const p = parseExecution({ dir: join(FIXTURES, "ios-device-pass") });
    expect(p.status).toBe("passed");
    expect(p.platform).toBe("ios");
    expect(p.flowName).toBe("fixture iOS 설정 검색");
    expect(p.appId).toBe("com.apple.Preferences");
    expect(p.exitCode).toBe(0);
    expect(p.steps.map((s) => [s.command, s.status])).toEqual([
      ["launchApp", "completed"],
      ["extendedWaitUntil", "completed"],
      ["tapOn", "completed"],
      ["inputText", "completed"],
      ["takeScreenshot", "completed"],
    ]);
    // inputText 값은 산출물에 없다(<text>)
    expect(p.steps[3]?.description).toBe('inputText "<text>"');
    expect(p.steps[4]?.screenshot).toMatch(/attempt-1\/01_search_typed\.png$/);
    expect(p.steps.every((s) => s.durationMs !== null && s.hierarchy === null)).toBe(true);
    expect(p.durationMs).toBeGreaterThan(0);
    expect(p.failure).toBeNull();
    const shot = p.artifacts.find((a) => a.kind === "take_screenshot");
    expect(shot?.stepIndex).toBe(4);
    expect(shot?.image?.width).toBeGreaterThan(0);
    expect(p.artifacts.some((a) => a.kind === "command_metadata")).toBe(true);
  });

  it("실패 실행: 실패 스텝·메시지·실패 캡처를 잇는다", () => {
    const p = parseExecution({ dir: join(FIXTURES, "ios-device-fail") });
    expect(p.status).toBe("failed");
    expect(p.failure?.kind).toBe("step_failed");
    expect(p.failure?.stepIndex).toBe(5);
    expect(p.failure?.message).toBe('Replay failed at step 6 (tapOn "fixture-account-7731 없음"): Maestro target "text":"fixture-account-7731 없음" did not match any element.');
    const failed = p.steps[5];
    expect(failed?.status).toBe("failed");
    expect(failed?.description).toBe('tapOn "${QA_FIXTURE_ACCOUNT_ID} 없음"');
    expect(failed?.failureScreenshot).toBe("failure.png");
    expect(p.artifacts.find((a) => a.path === "failure.png")).toMatchObject({ kind: "failure_screenshot", stepIndex: 5 });
    expect(p.artifacts.find((a) => a.path === "console.log")?.kind).toBe("console_log");
    expect(p.artifacts.some((a) => a.kind === "runner_log" && a.path.endsWith("failure.txt"))).toBe(true);
  });

  it("선택자에 들어간 -e 값은 가린 사본에서 사라진다", () => {
    const out = join(temp(), "redacted");
    expect(findSecretResidue(join(FIXTURES, "ios-device-fail"), [FAKE]).length).toBeGreaterThan(0);
    redactExecutionDir(join(FIXTURES, "ios-device-fail"), out, { secrets: [FAKE] });
    expect(findSecretResidue(out, [FAKE])).toEqual([]);
    const p = parseExecution({ dir: out });
    expect(p.failure?.message).not.toContain(FAKE);
    expect(p.status).toBe("failed");
  });

  it("러너·기기 문제는 환경 문제(env_issue)다", () => {
    const dir = temp();
    cpSync(join(FIXTURES, "ios-device-fail"), dir, { recursive: true });
    const attempt = join(dir, "agent-device", "0f1e2d3c4b5a6978", "flows__ios-fail.yaml", "attempt-1");
    const message = "Replay failed at step 2 (extendedWaitUntil): Developer mode is disabled for Apple development tools";
    writeFileSync(join(attempt, "failure.txt"), `status: failed\nmessage: ${message}\n`);
    const p = parseAgentDeviceExecution({ dir });
    expect(p.status).toBe("error");
    expect(p.failureClass).toBe("env_issue");
    expect(p.failure?.kind).toBe("driver_start");
  });

  it("시도 폴더가 없으면 콘솔 끝부분으로 error 를 낸다", () => {
    const dir = temp();
    cpSync(join(FIXTURES, "ios-device-fail", "console.log"), join(dir, "console.log"));
    writeFileSync(join(dir, "exit-code"), "1\n");
    const p = parseAgentDeviceExecution({ dir });
    expect(p.status).toBe("error");
    expect(p.failure?.kind).toBe("no_result");
    expect(p.steps).toEqual([]);
  });

  it("replay-timing.ndjson 이 깨졌으면 빈 스텝으로 넘기지 않는다", () => {
    const dir = temp();
    cpSync(join(FIXTURES, "ios-device-pass"), dir, { recursive: true });
    writeFileSync(join(dir, "agent-device", "0f1e2d3c4b5a6978", "flows__ios-pass.yaml", "attempt-1", "replay-timing.ndjson"), "{not json\n");
    expect(() => parseAgentDeviceExecution({ dir })).toThrow(EvidenceParseError);
  });

  it("메시지 끝의 플로우 경로·줄은 뗀다(괄호 안의 다른 말은 둔다)", () => {
    expect(cleanMessage("Replay failed at step 1 (launchApp): boom (/var/folders/x/flow/TC-1.yaml:line 6)")).toBe("Replay failed at step 1 (launchApp): boom");
    expect(cleanMessage("Failed (com.apple.dt.CoreDeviceError error 10002 (0x2712))")).toBe("Failed (com.apple.dt.CoreDeviceError error 10002 (0x2712))");
  });

  it("result.txt 의 키: 값 줄을 읽는다(처음 값만)", () => {
    const kv = parseKeyValues("status: failed\nmessage: a: b\nmessage: again\n");
    expect(kv.get("status")).toBe("failed");
    expect(kv.get("message")).toBe("a: b");
  });
});
