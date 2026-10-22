import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceParseError } from "./model";
import { parseExecution } from "./parse";
import { copyFixture, FAKE_ACCOUNT_ID, fixtureDir, FIXTURE_NAMES } from "./test-fixtures";

const flowDirOf = (dir: string) => {
  const session = readdirSync(join(dir, "maestro"))[0] ?? "";
  return join(dir, "maestro", session, readdirSync(join(dir, "maestro", session)).find((n) => !n.endsWith(".log")) ?? "");
};

describe("실제 산출물 픽스처", () => {
  it("iOS 통과: 스텝, 화면 캡처, 기기 정보를 읽는다", () => {
    const r = parseExecution({ dir: fixtureDir("ios-pass") });
    expect(r).toMatchObject({
      status: "passed",
      failure: null,
      failureClass: null,
      flowName: "fixture iOS 설정 검색",
      appId: "com.apple.Preferences",
      platform: "ios",
      exitCode: 0,
      warnings: [],
    });
    expect(r.device).toContain("QA Tool iPhone 17");
    expect(r.flowDir).toBe("maestro/2026-10-21_232346/fixture iOS 설정 검색");
    expect(r.steps.map((s) => s.command)).toEqual(["launchAppCommand", "assertConditionCommand", "tapOnElement", "inputTextCommand", "takeScreenshotCommand"]);
    expect(r.steps.every((s) => s.status === "completed")).toBe(true);
    // 설명은 평가 전 명령으로 만들어 변수 값이 아니라 이름이 보인다
    expect(r.steps[3]?.description).toBe('inputText "${QA_FIXTURE_ACCOUNT_ID}"');
    expect(r.steps.map((s) => s.description).join("\n")).not.toContain(FAKE_ACCOUNT_ID);
    const shot = r.steps[4]?.screenshot ?? "";
    expect(shot).toBe(`${r.flowDir}/takeScreenshot/01_search_typed.png`);
    const artifact = r.artifacts.find((a) => a.path === shot);
    expect(artifact).toMatchObject({ kind: "take_screenshot", stepIndex: 4 });
    expect(Math.max(artifact?.image?.width ?? 0, artifact?.image?.height ?? 0)).toBe(480);
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.startedAt).toMatch(/^2026-10-21T/);
    expect(new Set(r.artifacts.map((a) => a.kind))).toEqual(
      new Set(["console_log", "junit", "other", "command_metadata", "manifest", "maestro_log", "device_log", "take_screenshot", "runner_log"]),
    );
  });

  it("iOS 실패: 실패 스텝, 메시지, 실패 캡처·화면 트리를 연결한다", () => {
    const r = parseExecution({ dir: fixtureDir("ios-fail") });
    expect(r.status).toBe("failed");
    expect(r.failure).toEqual({ kind: "step_failed", message: `Element not found: Text matching regex: ${FAKE_ACCOUNT_ID} 없음`, stepIndex: 5 });
    const failed = r.steps[5];
    expect(failed).toMatchObject({ command: "tapOnElement", status: "failed", sequenceNumber: 7, description: 'tapOn text "${QA_FIXTURE_ACCOUNT_ID} 없음"' });
    // 실패 산출물 파일 이름의 step-NNN 은 sequenceNumber + 1
    expect(failed?.failureScreenshot).toMatch(/screenshots\/step-008-tapOnElement-\$\{QA_FIXTURE_ACCOUNT_ID\}_없음\.png$/);
    expect(failed?.hierarchy).toMatch(/screen-hierarchy\/step-008-tapOnElement-.*\.json$/);
    for (const p of [failed?.failureScreenshot, failed?.hierarchy]) {
      expect(r.artifacts.find((a) => a.path === p)?.stepIndex).toBe(5);
      expect(existsSync(join(fixtureDir("ios-fail"), p ?? ""))).toBe(true);
    }
    expect(r.steps[4]?.screenshot).toMatch(/takeScreenshot\/01_search_typed\.png$/);
    expect(r.warnings).toEqual([]);
  });

  it("Android 통과·실패: logcat 을 기기 로그로, 플랫폼을 android 로 본다", () => {
    const pass = parseExecution({ dir: fixtureDir("android-pass") });
    expect(pass).toMatchObject({ status: "passed", platform: "android", appId: "com.android.settings", warnings: [] });
    expect(pass.steps[0]).toMatchObject({ command: "stopAppCommand", description: "stopApp com.google.android.settings.intelligence" });
    expect(pass.artifacts.find((a) => a.path.endsWith("logs/device-logcat.txt"))?.kind).toBe("device_log");
    expect(pass.device).toContain("emulator-5554");

    const fail = parseExecution({ dir: fixtureDir("android-fail") });
    expect(fail).toMatchObject({ status: "failed", platform: "android", failure: { kind: "step_failed", stepIndex: 7 } });
    expect(fail.steps[7]?.failureScreenshot).toMatch(/step-010-tapOnElement/);
  });

  it("드라이버 시작 실패(PoC 실제 산출물): 플로우 없이 env_issue 로 분류한다", () => {
    const r = parseExecution({ dir: fixtureDir("ios-driver-timeout") });
    expect(r).toMatchObject({
      status: "error",
      failureClass: "env_issue",
      flowDir: null,
      sessionDir: "maestro/2026-10-21_150342",
      platform: "ios",
      exitCode: null,
      steps: [],
      failure: { kind: "driver_start", stepIndex: null },
    });
    expect(r.failure?.message).toContain("iOS driver not ready in time");
    expect(r.artifacts.map((a) => a.kind).sort()).toEqual(["console_log", "runner_log"]);
  });

  it("모든 픽스처의 결과가 스키마를 통과하고 산출물 경로가 실제로 있다", () => {
    for (const name of FIXTURE_NAMES) {
      const r = parseExecution({ dir: fixtureDir(name) });
      for (const a of r.artifacts) expect(existsSync(join(fixtureDir(name), a.path))).toBe(true);
      for (const s of r.steps) {
        for (const p of [s.screenshot, s.failureScreenshot, s.hierarchy]) if (p) expect(existsSync(join(fixtureDir(name), p))).toBe(true);
      }
    }
  });
});

describe("이상한 산출물은 조용히 넘기지 않는다", () => {
  it("플로우 폴더에 commands.json 이 없으면 오류", () => {
    const dir = copyFixture("ios-pass");
    rmSync(join(flowDirOf(dir), "commands.json"));
    expect(() => parseExecution({ dir })).toThrow(EvidenceParseError);
  });

  it("commands.json 의 상태 값이 모르는 값이면 오류(빈 스텝으로 바꾸지 않음)", () => {
    const dir = copyFixture("ios-pass");
    const f = join(flowDirOf(dir), "commands.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"status" : "COMPLETED"', '"status" : "MAYBE"').replace('"status": "COMPLETED"', '"status": "MAYBE"'));
    expect(() => parseExecution({ dir })).toThrow(/commands\.json 형식이 다르다/);
  });

  it("깨진 JSON 은 오류", () => {
    const dir = copyFixture("ios-pass");
    writeFileSync(join(flowDirOf(dir), "commands.json"), "[{");
    expect(() => parseExecution({ dir })).toThrow(EvidenceParseError);
  });

  it("실행 하나에 플로우가 둘이면 오류", () => {
    const dir = copyFixture("ios-pass");
    mkdirSync(join(flowDirOf(dir), "..", "another flow"));
    expect(() => parseExecution({ dir })).toThrow(/여러 개/);
  });

  it("증적 폴더의 심볼릭 링크는 오류", () => {
    const dir = copyFixture("ios-pass");
    symlinkSync("/etc/hosts", join(dir, "link"));
    expect(() => parseExecution({ dir })).toThrow(/심볼릭 링크/);
  });

  it("산출물이 전혀 없으면 no_result, 드라이버가 아닌 예외면 flow_error", () => {
    const empty = mkdtempSync(join(tmpdir(), "qa-evidence-empty-"));
    expect(parseExecution({ dir: empty })).toMatchObject({ status: "error", failureClass: null, failure: { kind: "no_result" } });
    writeFileSync(join(empty, "console.log"), "\u001b[31mmaestro.orchestra.error.SyntaxError: Invalid command: tapOnn\u001b[0m\n\tat x.y(Z.kt:1)\n");
    expect(parseExecution({ dir: empty })).toMatchObject({ status: "error", failureClass: null, failure: { kind: "flow_error", message: "Invalid command: tapOnn" } });
  });

  it("JUnit·종료 코드가 없고 실행 중 스텝이 남았으면 interrupted", () => {
    const dir = copyFixture("ios-pass");
    rmSync(join(dir, "junit.xml"));
    rmSync(join(dir, "exit-code"));
    const f = join(flowDirOf(dir), "commands.json");
    const commands = JSON.parse(readFileSync(f, "utf8")) as { metadata: { status: string } }[];
    const last = commands.at(-1);
    if (last) last.metadata.status = "RUNNING";
    writeFileSync(f, JSON.stringify(commands));
    expect(parseExecution({ dir })).toMatchObject({ status: "error", failure: { kind: "interrupted", stepIndex: 4 } });
  });

  it("JUnit 은 통과인데 실패 스텝이 있거나 종료 코드가 다르면 경고를 남긴다", () => {
    const dir = copyFixture("ios-fail");
    writeFileSync(join(dir, "junit.xml"), readFileSync(join(dir, "junit.xml"), "utf8").replace('status="ERROR"', 'status="SUCCESS"').replace(/<failure>[\s\S]*?<\/failure>/, ""));
    const r = parseExecution({ dir });
    expect(r.status).toBe("passed");
    expect(r.warnings.join("\n")).toMatch(/실패한 스텝이 있다/);
    expect(r.warnings.join("\n")).toMatch(/종료 코드 1/);
  });

  it("JUnit 의 플로우 이름이 다른 유니코드 정규화(NFD)여도 맞춘다", () => {
    const dir = copyFixture("ios-fail");
    const junit = readFileSync(join(dir, "junit.xml"), "utf8");
    writeFileSync(join(dir, "junit.xml"), junit.replaceAll("fixture iOS 설정 검색 실패", "fixture iOS 설정 검색 실패".normalize("NFD")));
    const r = parseExecution({ dir });
    expect(r.status).toBe("failed");
    expect(r.durationMs).toBe(87174);
    expect(r.warnings).toEqual([]);
  });

  it("manifest 에 있는 파일이 없으면 경고", () => {
    const dir = copyFixture("ios-pass");
    rmSync(join(flowDirOf(dir), "logs", "device-xctest.log"));
    expect(parseExecution({ dir }).warnings.join("\n")).toMatch(/매니페스트에 있지만 없는 산출물: .*device-xctest\.log/);
  });
});
