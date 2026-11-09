import { PATTERN_RULES_VERSION, rescrubRedactedDir } from "@qa/evidence";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = ".redaction-rules";

/**
 * 가림 모양 규칙이 바뀐 뒤 처음 켤 때, 이미 저장한 가린 사본(evidence/<실행>/<시도>/redacted)에 지금 규칙을 한 번 다시 적용한다.
 * 원본(raw)은 건드리지 않는다. 다 적용한 뒤에만 규칙 버전을 표시 파일에 남기므로, 중간에 실패하면 다음에 다시 한다
 */
export function rescrubEvidence(root: string): { version: number; dirs: number; files: number; skipped: boolean } {
  const markerPath = join(root, MARKER);
  const done = existsSync(markerPath) ? Number(readFileSync(markerPath, "utf8").trim()) || 0 : 0;
  if (done >= PATTERN_RULES_VERSION) return { version: done, dirs: 0, files: 0, skipped: true };
  let dirs = 0;
  let files = 0;
  if (existsSync(root)) {
    for (const run of readdirSync(root, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      for (const attempt of readdirSync(join(root, run.name), { withFileTypes: true })) {
        const redacted = join(root, run.name, attempt.name, "redacted");
        if (!attempt.isDirectory() || !existsSync(redacted)) continue;
        files += rescrubRedactedDir(redacted);
        dirs += 1;
      }
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(markerPath, `${PATTERN_RULES_VERSION}\n`, { mode: 0o600 });
  return { version: PATTERN_RULES_VERSION, dirs, files, skipped: false };
}
