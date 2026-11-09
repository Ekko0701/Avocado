import { PATTERN_RULES_VERSION } from "@qa/evidence";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rescrubEvidence } from "./rescrub";

describe("rescrubEvidence", () => {
  it("저장된 가린 사본에 새 규칙을 한 번만 적용하고, 원본은 건드리지 않는다", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-rescrub-"));
    const leaked = "[TextInputHelper] first character: x\n[TextInputHelper] remaining text: yz-fake-0000\n";
    for (const part of ["raw", "redacted"]) {
      mkdirSync(join(root, "run-1", "exec-1", part, "maestro"), { recursive: true });
      writeFileSync(join(root, "run-1", "exec-1", part, "maestro", "xctest_runner.log"), leaked);
    }
    writeFileSync(join(root, "run-1", "exec-1", "redacted", "exit-code"), "1\n");

    expect(rescrubEvidence(root)).toEqual({ version: PATTERN_RULES_VERSION, dirs: 1, files: 1, skipped: false });
    expect(readFileSync(join(root, "run-1", "exec-1", "redacted", "maestro", "xctest_runner.log"), "utf8")).not.toContain("yz-fake");
    expect(readFileSync(join(root, "run-1", "exec-1", "raw", "maestro", "xctest_runner.log"), "utf8")).toBe(leaked);
    expect(rescrubEvidence(root)).toEqual({ version: PATTERN_RULES_VERSION, dirs: 0, files: 0, skipped: true });
  });

  it("증적 폴더가 없어도 표시만 남긴다", () => {
    const root = join(mkdtempSync(join(tmpdir(), "qa-rescrub-")), "evidence");
    expect(rescrubEvidence(root)).toMatchObject({ dirs: 0, files: 0, skipped: false });
    expect(rescrubEvidence(root).skipped).toBe(true);
  });
});
