import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ENV_NAME = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
const FLOW_REF = /^\s*(?:-\s*)?(?:runFlow|file):\s*["']?([^"'\s#]+)/gm;

/**
 * 플로우와 그 플로우가 runFlow 로 부르는 파일(상대 경로, 차례로 따라감)이 ${이름} 으로 쓰는 이름.
 * 없는 파일은 건너뛴다. 그 오류는 실행할 때 Maestro 가 낸다
 */
export function referencedEnvNames(flowPath: string): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string) => {
    const abs = resolve(path);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(ENV_NAME)) if (m[1]) names.add(m[1]);
    for (const m of text.matchAll(FLOW_REF)) {
      const ref = m[1];
      if (ref && !ref.startsWith("/")) visit(join(dirname(abs), ref));
    }
  };
  visit(flowPath);
  return names;
}
