import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "../audit";
import { Budget, MODE_LIMITS } from "../budget";
import { judgeCapture } from "./judge";
import { judgeMetrics, metricsMarkdown, type LabeledVerdict } from "./metrics";

/**
 * 실제 API 로 judge 정밀도를 잰다(T-115 완료 기준). 비용이 들어 기본은 건너뛴다.
 * QA_JUDGE_EVAL=1 QA_JUDGE_DATASET=<labels.json 이 있는 폴더> ANTHROPIC_API_KEY=… QA_JUDGE_REPORT=docs/poc/judge-precision.md
 * labels.json: [{ "id": "01", "image": "01.png", "expectation": "…", "label": "pass" | "fail" }]
 * 캡처 30장, 약 $0.5 (이미지 1장 ≈ 입력 1.5k 토큰). 데이터 만드는 법은 docs/poc/judge-dataset.md
 */
const enabled = process.env["QA_JUDGE_EVAL"] === "1";
const Labels = z.array(z.strictObject({ id: z.string(), image: z.string(), expectation: z.string(), label: z.enum(["pass", "fail"]) })).min(1);

describe.skipIf(!enabled)("judge 정밀도(실제 API)", () => {
  it("라벨링한 캡처로 정밀도를 보고한다", async () => {
    const dir = process.env["QA_JUDGE_DATASET"] ?? "";
    const labels = Labels.parse(JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")));
    const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"], baseURL: "https://api.anthropic.com", maxRetries: 2 });
    const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), "qa-judge-eval-")), "audit.jsonl"), { jobId: "judge-eval", secrets: [] });
    const rows: LabeledVerdict[] = [];
    for (const l of labels) {
      const budget = new Budget(MODE_LIMITS.judge, { monthlyRemainingUsd: 5 });
      const r = await judgeCapture({
        client,
        image: { data: readFileSync(join(dir, l.image)), mimeType: l.image.endsWith(".jpg") ? "image/jpeg" : "image/png" },
        expectation: l.expectation,
        context: { tcId: "eval", step: l.id },
        budget,
        audit,
      });
      rows.push({ id: l.id, label: l.label, predicted: r.verdict, costUsd: budget.snapshot().costUsd });
    }
    const m = judgeMetrics(rows);
    const report = metricsMarkdown(m, { model: "claude-opus-5-5", date: new Date().toISOString().slice(0, 10), dataset: dir });
    if (process.env["QA_JUDGE_REPORT"]) writeFileSync(process.env["QA_JUDGE_REPORT"], report);
    console.log(report);
    expect(m.total).toBe(labels.length);
  }, 600_000);
});
