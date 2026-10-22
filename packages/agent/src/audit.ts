import { buildSecretSet, redactText, type SecretSet } from "@qa/evidence";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 감사 기록(PLAN 6.4): 도구 호출·결과·사용량을 JSONL 로. 비밀 값과 토큰 모양은 가리고, 이미지는 크기만 남긴다 */
export interface AuditEntry {
  kind: "tool_call" | "tool_result" | "tool_denied" | "model_usage" | "budget_exceeded" | "job" | "claude_attach";
  [key: string]: unknown;
}

const MAX_STRING = 4000;

export class AuditLog {
  private readonly secrets: SecretSet;

  constructor(
    readonly file: string,
    options: { jobId: string; secrets: readonly string[]; now?: () => Date },
  ) {
    this.secrets = buildSecretSet(options.secrets);
    this.jobId = options.jobId;
    this.now = options.now ?? (() => new Date());
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  private readonly jobId: string;
  private readonly now: () => Date;

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ at: this.now().toISOString(), jobId: this.jobId, ...entry }, (_key, value: unknown) => {
      if (typeof value === "string") {
        // base64 이미지 데이터는 남기지 않는다
        if (value.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(value)) return `[base64 ${value.length}자 생략]`;
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length}자 중 ${MAX_STRING}자)` : value;
      }
      return value;
    });
    appendFileSync(this.file, `${redactText(line, this.secrets).text}\n`, { mode: 0o600 });
  }
}
