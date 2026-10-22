import { parse as parseYaml } from "yaml";
import { TestcaseFrontMatterSchema, type TestcaseFrontMatter } from "./schemas";

/** TC 파일(PLAN 4.2): YAML front matter + "## 전제조건", "## 스텝", "## 완료 기준" */
export interface TestcaseStep {
  action: string;
  expected: string[];
  /** 파일에서 스텝이 시작하는 줄(1부터). 직렬화한 문서에서는 없다 */
  line?: number;
}

export interface TestcaseDoc {
  frontMatter: TestcaseFrontMatter;
  preconditions: string[];
  steps: TestcaseStep[];
  doneCriteria: string[];
  /** 알 수 없는 "## " 제목 */
  otherSections: string[];
}

export interface Issue {
  path: string;
  message: string;
  /** 1부터. 알 수 없으면 null */
  line: number | null;
}

export type ParseResult = { ok: true; doc: TestcaseDoc } | { ok: false; issues: Issue[] };

type SectionKey = "preconditions" | "steps" | "doneCriteria";
const SECTION: Record<string, SectionKey | undefined> = { 전제조건: "preconditions", 스텝: "steps", "완료 기준": "doneCriteria" };

export function parseTestcase(text: string, path = "TC.md"): ParseResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { ok: false, issues: [{ path, line: 1, message: "첫 줄이 --- 인 front matter 가 필요하다" }] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { ok: false, issues: [{ path, line: 1, message: "front matter 를 닫는 --- 가 없다" }] };
  let raw: unknown;
  try {
    raw = parseYaml(lines.slice(1, end).join("\n"));
  } catch (error) {
    return { ok: false, issues: [{ path, line: 2, message: `front matter YAML 오류: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const fm = TestcaseFrontMatterSchema.safeParse(raw);
  if (!fm.success) {
    return { ok: false, issues: fm.error.issues.map((i) => ({ path, line: 2, message: `front matter ${i.path.join(".") || "(전체)"}: ${i.message}` })) };
  }

  const doc: TestcaseDoc = { frontMatter: fm.data, preconditions: [], steps: [], doneCriteria: [], otherSections: [] };
  let section: SectionKey | "other" | null = null;
  for (let i = end + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      section = SECTION[heading[1]] ?? "other";
      if (section === "other") doc.otherSections.push(heading[1]);
      continue;
    }
    if (!line.trim() || section === null || section === "other") continue;
    if (section === "steps") {
      const step = /^\d+[.)]\s+(.*)$/.exec(line.trim());
      const expected = /^\s*[-*]\s*기대\s*[:：]\s*(.*)$/.exec(line);
      if (step && !/^\s/.test(line)) doc.steps.push({ action: (step[1] ?? "").trim(), expected: [], line: i + 1 });
      else if (expected && doc.steps.length > 0) doc.steps.at(-1)?.expected.push((expected[1] ?? "").trim());
      else if (doc.steps.length > 0) {
        const last = doc.steps.at(-1);
        if (last) last.action = `${last.action} ${line.trim().replace(/^[-*]\s*/, "")}`.trim();
      }
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    doc[section].push((item?.[1] ?? line).trim());
  }
  return { ok: true, doc };
}
