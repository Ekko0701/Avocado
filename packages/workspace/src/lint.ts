import { parseTestcase, type TestcaseDoc } from "./testcase";

/** TC 린트(PLAN 4.2). error 는 저장·제출을 막고, warning 은 알리기만 한다 */
export interface LintIssue {
  level: "error" | "warning";
  rule: string;
  message: string;
  line: number | null;
  /** 0부터. 스텝과 무관하면 null */
  step: number | null;
}

export interface LintContext {
  /** accounts.yaml 의 역할 이름. 모르면 null(규칙을 건너뛴다) */
  accountRoles: string[] | null;
  /** app.yaml 의 타깃. 모르면 null */
  appTargets: string[] | null;
}

const LAUNCH = /앱을\s*(실행|켠|켜|연다|열고|시작)/;
const VAGUE = /(선택|확인)(한다|하고|해)\.?$/;
const QUOTED = /['"‘’“”「」]/;

export function lintTestcase(text: string, ctx: LintContext, path = "TC.md"): { doc: TestcaseDoc | null; issues: LintIssue[] } {
  const parsed = parseTestcase(text, path);
  if (!parsed.ok) return { doc: null, issues: parsed.issues.map((i) => ({ level: "error", rule: "front-matter", message: i.message, line: i.line, step: null })) };
  const { doc } = parsed;
  const issues: LintIssue[] = [];
  const add = (level: LintIssue["level"], rule: string, message: string, step: number | null = null, line: number | null = null) =>
    issues.push({ level, rule, message, step, line });

  if (doc.steps.length === 0) add("error", "steps-required", "스텝이 1개 이상 있어야 한다(## 스텝 아래 번호 목록)");
  if (doc.doneCriteria.length === 0) add("error", "done-required", "완료 기준이 있어야 한다(## 완료 기준)");
  doc.steps.forEach((s, i) => {
    if (!s.action.trim()) add("error", "step-action", `스텝 ${i + 1} 에 동작이 없다`, i, s.line ?? null);
    if (s.expected.length === 0 || s.expected.every((e) => !e.trim())) add("error", "step-expected", `스텝 ${i + 1} 에 "기대"가 없다(- 기대: …)`, i, s.line ?? null);
    if (LAUNCH.test(s.action)) add("warning", "launch-step", `스텝 ${i + 1}: 앱 실행은 공통 서브플로우가 한다. 전제조건으로 옮긴다`, i, s.line ?? null);
    if (VAGUE.test(s.action.trim()) && !QUOTED.test(s.action)) {
      add("warning", "vague-verb", `스텝 ${i + 1}: "선택한다·확인한다"만으로는 모호하다. 누를 대상이나 볼 문구를 '…'로 쓴다`, i, s.line ?? null);
    }
  });
  const account = doc.frontMatter.account;
  if (account && ctx.accountRoles && !ctx.accountRoles.includes(account)) {
    add("error", "account-role", `account "${account}" 가 accounts.yaml 에 없다(있는 역할: ${ctx.accountRoles.join(", ") || "없음"})`, null, 2);
  }
  if (ctx.appTargets) {
    for (const t of doc.frontMatter.targets) {
      if (!ctx.appTargets.includes(t)) add("warning", "target-unknown", `타깃 ${t} 가 app.yaml 에 없다`, null, 2);
    }
  }
  return { doc, issues };
}

export const hasBlocking = (issues: LintIssue[]) => issues.some((i) => i.level === "error");
