import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EvidenceParseError } from "./model";

/** 폴더 안의 모든 파일(하위 포함). 심볼릭 링크는 따라가지 않고 오류로 본다(증적 폴더 밖을 가리킬 수 있다). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new EvidenceParseError(`증적 폴더에 심볼릭 링크가 있다: ${p}`);
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) out.push(p);
    }
  };
  visit(dir);
  return out;
}
