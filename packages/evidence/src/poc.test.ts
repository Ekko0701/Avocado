import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseExecution } from "./parse";
import { findSecretResidue, redactExecutionDir } from "./redact";

/**
 * PoC 의 실제 앱 산출물(커밋하지 않음)로 파서·가림을 확인한다. 로컬에서만 따로 켠다.
 *   QA_EVIDENCE_POC_RUNS=$PWD/out/poc/runs QA_EVIDENCE_POC_APP_ID=<번들 ID> QA_EVIDENCE_POC_ENV=$PWD/.env pnpm --filter @qa/evidence test
 * .env 값은 읽기만 하고 출력하지 않는다. 결과에는 경로와 개수만 나온다.
 */
const RUNS = process.env["QA_EVIDENCE_POC_RUNS"];
const APP_ID = process.env["QA_EVIDENCE_POC_APP_ID"];
const ENV = process.env["QA_EVIDENCE_POC_ENV"];

function envValues(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && l.includes("="))
    .map((l) => l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, ""))
    .filter((v) => v.length > 0);
}

describe.skipIf(!RUNS || !APP_ID)("PoC 실제 앱 산출물", () => {
  const root = resolve(RUNS ?? ".");
  const runs = RUNS ? readdirSync(root).filter((n) => /^\d{8}-\d{6}-/.test(n)).sort() : [];

  it("PoC 실행이 있다", () => {
    expect(runs.length).toBeGreaterThan(0);
  });

  it.each(runs)("%s: JUnit 결과와 같은 상태로 파싱한다", (name) => {
    const dir = join(root, name);
    const r = parseExecution({ dir, outputDir: dir });
    const junit = join(dir, "junit.xml");
    if (!existsSync(junit)) {
      expect(r).toMatchObject({ status: "error", failureClass: "env_issue", failure: { kind: "driver_start" } });
      return;
    }
    const failures = Number(/failures="(\d+)"/.exec(readFileSync(junit, "utf8"))?.[1] ?? "NaN");
    expect(r.status).toBe(failures === 0 ? "passed" : "failed");
    expect(r.platform).toBe("ios");
    expect(r.appId).toBe(APP_ID);
    expect(r.steps.length).toBeGreaterThan(0);
    if (failures > 0) expect(r.failure?.kind).toBe("step_failed");
    expect(r.warnings).toEqual([]);
  });

  it.skipIf(!ENV)("PoC 산출물에 .env 값이 남아 있지 않다(값 기준)", () => {
    const secrets = envValues(resolve(ENV ?? ""));
    expect(secrets.length).toBeGreaterThan(0);
    const residue = findSecretResidue(root, secrets).filter((r) => r.occurrences > 0 || r.inPath);
    expect(residue).toEqual([]);
  });

  it.skipIf(!ENV).each(runs)("%s: 가린 사본에는 값·모양 규칙 잔존이 없고 파싱 결과가 같다", (name) => {
    const secrets = envValues(resolve(ENV ?? ""));
    const dir = join(root, name);
    const out = join(mkdtempSync(join(tmpdir(), "qa-poc-redacted-")), name);
    redactExecutionDir(dir, out, { secrets });
    expect(findSecretResidue(out, secrets)).toEqual([]);
    const a = parseExecution({ dir, outputDir: dir });
    const b = parseExecution({ dir: out, outputDir: out });
    expect([b.status, b.steps.length, b.failure?.kind]).toEqual([a.status, a.steps.length, a.failure?.kind]);
  });
});
