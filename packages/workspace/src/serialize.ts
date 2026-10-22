import { Document, isSeq } from "yaml";
import type { TestcaseFrontMatter } from "./schemas";
import type { TestcaseStep } from "./testcase";

export interface TestcaseContent {
  frontMatter: TestcaseFrontMatter;
  preconditions: string[];
  steps: TestcaseStep[];
  doneCriteria: string[];
}

const KEY_ORDER: (keyof TestcaseFrontMatter)[] = ["id", "title", "app", "targets", "priority", "tags", "account", "status"];

/** TC 를 파일 형식(PLAN 4.2)으로. parseTestcase 와 왕복해도 내용이 같다 */
export function serializeTestcase(tc: TestcaseContent): string {
  const fm: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const v = tc.frontMatter[key];
    if (v === undefined || (Array.isArray(v) && v.length === 0 && key === "tags")) continue;
    fm[key] = v;
  }
  const doc = new Document(fm);
  for (const key of ["targets", "tags"]) {
    const node = doc.get(key, true);
    if (isSeq(node)) node.flow = true;
  }
  const one = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
  const lines = ["---", doc.toString({ lineWidth: 0 }).trimEnd(), "---", "## 전제조건"];
  for (const p of tc.preconditions) lines.push(`- ${one(p)}`);
  lines.push("", "## 스텝");
  tc.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${one(s.action)}`);
    for (const e of s.expected) lines.push(`   - 기대: ${one(e)}`);
  });
  lines.push("", "## 완료 기준");
  for (const d of tc.doneCriteria) lines.push(`- ${one(d)}`);
  return `${lines.join("\n")}\n`;
}
