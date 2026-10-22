import { buildSummaryBundle, checkBundle } from "@qa/evidence";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSipsJpegConverter } from "../agent/image";
import { runCommand } from "../setup/command";

/**
 * 실제 실행 증적(가린 사본)으로 요약 묶음을 만들어 본다. 업로드는 하지 않는다.
 * QA_REAL_BUNDLE_DIR=<userData/evidence/<run>/<exec>/redacted> QA_REAL_BUNDLE_RESULT=passed|failed
 */
const dir = process.env["QA_REAL_BUNDLE_DIR"];

describe.skipIf(!dir)("실제 증적으로 요약 묶음", () => {
  it("캡처는 실제 JPEG(긴 변 720px 이하), 홈 폴더 경로·비밀 값 없음, 20MB 이하", async () => {
    const result = process.env["QA_REAL_BUNDLE_RESULT"] === "failed" ? "failed" : "passed";
    const bundle = await buildSummaryBundle({
      meta: { runId: "real-run", executionId: "real-exec", attempt: 1, tcId: "TC-0101", app: "demo", target: "ios", flowName: "TC-0101 이메일 회원가입", deviceName: "QA Tool iPhone 17", buildLabel: "com.example.demo", result, flaky: false, failureClass: null, createdAt: new Date().toISOString(), finishedAt: null, generator: "qa-tool real-check" },
      redactedDir: dir ?? "",
      includePassScreens: true,
      secrets: [homedir()],
      toJpeg: createSipsJpegConverter(runCommand, join(mkdtempSync(join(tmpdir(), "qa-real-bundle-")), "tmp")),
      date: new Date(),
    });
    const screens = bundle.files.filter((f) => f.kind === "screen" || f.kind === "failure_screen");
    console.log(JSON.stringify({ files: bundle.files.map((f) => `${f.path} ${f.content.length}`), total: bundle.totalBytes, warnings: bundle.warnings }, null, 1));
    expect(screens.length).toBeGreaterThan(0);
    for (const s of screens) expect(s.content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), s.path).toBe(true);
    expect(bundle.totalBytes).toBeLessThan(20 * 1024 * 1024);
    expect(checkBundle(bundle, [homedir()])).toEqual([]);
    const text = bundle.files.filter((f) => !f.path.endsWith(".jpg")).map((f) => f.content.toString("utf8")).join("\n");
    expect(text).not.toContain(homedir());
  });
});
