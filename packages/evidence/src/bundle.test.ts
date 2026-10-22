import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BundleError, buildSummaryBundle, checkBundle, type BundleMeta, type JpegConverter } from "./bundle";
import { redactExecutionDir } from "./redact";
import { FAKE_ACCOUNT_ID, FAKE_ACCOUNT_PW, FAKE_SECRETS, fixtureDir, type FixtureName } from "./test-fixtures";

// 실제 변환은 main 의 sips. 여기서는 크기만 흉내 낸다
const fakeJpeg: JpegConverter = async (png, o) => Buffer.from(`JPEG ${o.maxSide} q${o.quality} ${png.length}`);
const date = new Date(2026, 9, 22, 9, 30);

function meta(result: BundleMeta["result"]): BundleMeta {
  return {
    runId: "run-1",
    executionId: "exec-1",
    attempt: 1,
    tcId: "TC-0009",
    app: "settings",
    target: "ios",
    flowName: "fixture iOS 설정 검색",
    deviceName: "QA Tool iPhone 17 / iOS 27.0",
    buildLabel: null,
    result,
    flaky: false,
    failureClass: result === "failed" ? "unknown" : null,
    createdAt: "2026-10-22T00:30:00.000Z",
    finishedAt: "2026-10-22T00:31:00.000Z",
    generator: "qa-tool 0.0.0",
  };
}

function redacted(name: FixtureName): string {
  const out = join(mkdtempSync(join(tmpdir(), "qa-bundle-")), "redacted");
  redactExecutionDir(fixtureDir(name), out, { secrets: FAKE_SECRETS });
  return out;
}

describe("요약 묶음 (PLAN 9.2)", () => {
  it("실패 실행: run.json·report.md·화면/실패 캡처(JPEG)·실패 스텝 뷰 계층·로그 발췌. 비밀 값 없음", async () => {
    const bundle = await buildSummaryBundle({ meta: meta("failed"), redactedDir: redacted("ios-fail"), includePassScreens: false, secrets: FAKE_SECRETS, toJpeg: fakeJpeg, date });
    expect(bundle.root).toBe("runs/2026/10/22/run-1/exec-1");
    expect(bundle.indexPath).toBe("index/2026-10.jsonl");
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["run.json", "report.md", "screens/01_search_typed.jpg", "logs/maestro-excerpt.txt", "logs/console-tail.txt"]));
    expect(paths.some((p) => /^screens\/failure-step-\d\d\.jpg$/.test(p))).toBe(true);
    expect(paths.some((p) => /^hierarchy\/failure-step-\d\d\.json$/.test(p))).toBe(true);
    // 영상·원본 로그·원본 트리 없음
    expect(paths.some((p) => /\.(mp4|png)$|device-|xctest_runner|commands\.json/.test(p))).toBe(false);
    expect(bundle.files.find((f) => f.path === "screens/01_search_typed.jpg")?.content.toString()).toMatch(/^JPEG 720 q70/);

    const runJson = JSON.parse(bundle.files.find((f) => f.path === "run.json")?.content.toString() ?? "{}") as { result: string; failure: { kind: string }; steps: unknown[] };
    expect(runJson.result).toBe("failed");
    expect(runJson.failure.kind).toBe("step_failed");
    expect(runJson.steps.length).toBeGreaterThan(3);
    const report = bundle.files.find((f) => f.path === "report.md")?.content.toString() ?? "";
    expect(report).toContain("# TC-0009 fixture iOS 설정 검색 — 실패");
    expect(report).toContain("](screens/01_search_typed.jpg)");

    const all = Buffer.concat(bundle.files.map((f) => f.content)).toString("utf8") + bundle.indexLine;
    expect(all).not.toContain(FAKE_ACCOUNT_ID);
    expect(all).not.toContain(FAKE_ACCOUNT_PW);
    expect(checkBundle(bundle, FAKE_SECRETS)).toEqual([]);
  });

  it("통과 실행: 화면 캡처는 기본 제외, 옵션으로 포함. 로그는 넣지 않는다", async () => {
    const dir = redacted("ios-pass");
    const plain = await buildSummaryBundle({ meta: meta("passed"), redactedDir: dir, includePassScreens: false, secrets: FAKE_SECRETS, toJpeg: fakeJpeg, date });
    expect(plain.files.map((f) => f.path)).toEqual(["run.json", "report.md"]);
    const withScreens = await buildSummaryBundle({ meta: meta("passed"), redactedDir: dir, includePassScreens: true, secrets: FAKE_SECRETS, toJpeg: fakeJpeg, date });
    expect(withScreens.files.map((f) => f.path)).toEqual(["run.json", "report.md", "screens/01_search_typed.jpg"]);
  });

  it("20MB 를 넘으면 캡처를 줄이고, 그래도 넘으면 실패 캡처만, 그래도 넘으면 만들지 않는다", async () => {
    const big: JpegConverter = async (_png, o) => Buffer.alloc(o.maxSide === 720 ? 6000 : 3000);
    const dir = redacted("ios-fail");
    const base = await buildSummaryBundle({ meta: meta("failed"), redactedDir: dir, includePassScreens: false, secrets: FAKE_SECRETS, toJpeg: async () => Buffer.alloc(0), date });
    // 캡처 2장(화면 1, 실패 1)을 뺀 크기. run.json 의 파일 목록이 조금 달라질 수 있어 여유를 둔다
    const text = base.totalBytes + 200;
    const build = (maxBytes: number) => buildSummaryBundle({ meta: meta("failed"), redactedDir: dir, includePassScreens: false, secrets: FAKE_SECRETS, toJpeg: big, date, maxBytes });
    const shrunk = await build(text + 9000);
    expect(shrunk.warnings).toEqual(["묶음이 커서 캡처를 480px·품질 50 으로 줄였다"]);
    expect(shrunk.totalBytes).toBeLessThanOrEqual(text + 9000);
    const failureOnly = await build(text + 4000);
    expect(failureOnly.files.some((f) => f.kind === "screen")).toBe(false);
    expect(failureOnly.files.some((f) => f.kind === "failure_screen")).toBe(true);
    await expect(build(text + 1000)).rejects.toThrow(BundleError);
  });

  it("검사: 묶음에 비밀 값이 남아 있으면 찾아낸다(가리지 않은 폴더로 만든 경우)", async () => {
    // 일부러 가리지 않은 원본으로 만들고, 만들 때 가릴 값을 주지 않는다
    const leaky = await buildSummaryBundle({ meta: meta("failed"), redactedDir: fixtureDir("ios-fail"), includePassScreens: false, secrets: [], toJpeg: fakeJpeg, date });
    const residue = checkBundle(leaky, FAKE_SECRETS);
    expect(residue.length).toBeGreaterThan(0);
    expect(JSON.stringify(residue)).not.toContain(FAKE_ACCOUNT_PW);
  });
});
