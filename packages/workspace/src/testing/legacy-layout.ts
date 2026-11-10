import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 테스트용: 새 구조(schemaVersion 2)의 워크스페이스 폴더를 예전 구조(1)로 되돌린다(ADR 0032).
 * 예시 워크스페이스는 새 구조라서, 예전 구조 읽기와 변환을 시험할 때 쓴다.
 */
export function toLegacyLayout(root: string): void {
  for (const app of readdirSync(join(root, "apps"))) {
    for (const kind of ["testcases", "flows"]) {
      const from = join(root, "apps", app, kind);
      if (!existsSync(from) || !statSync(from).isDirectory()) continue;
      mkdirSync(join(root, kind), { recursive: true });
      renameSync(from, join(root, kind, app));
    }
  }
  const ws = join(root, "workspace.yaml");
  writeFileSync(ws, readFileSync(ws, "utf8").replace(/^schemaVersion: 2$/m, "schemaVersion: 1"));
}
