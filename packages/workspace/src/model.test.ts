import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasBlocking, lintTestcase, nextTestcaseId, parseTestcase, serializeTestcase, testcaseTemplate, type LintContext } from "./model";

const EXAMPLE_TC = readFileSync(resolve(__dirname, "../../../examples/qa-workspace/testcases/demo/TC-0101.md"), "utf8");
const CTX: LintContext = { accountRoles: ["signup"], appTargets: ["ios"] };

const strip = <T extends { steps: { line?: number }[] }>(d: T) => ({ ...d, steps: d.steps.map((s) => ({ ...s, line: undefined })) });

describe("직렬화", () => {
  it("예시 TC 를 읽고 다시 쓰면 같은 내용으로 읽힌다", () => {
    const a = parseTestcase(EXAMPLE_TC);
    if (!a.ok) throw new Error("예시 TC 파싱 실패");
    const text = serializeTestcase(a.doc);
    const b = parseTestcase(text);
    if (!b.ok) throw new Error(b.issues.map((i) => i.message).join());
    expect(strip(b.doc)).toEqual(strip(a.doc));
    expect(text).toContain("targets: [ ios ]");
    expect(text.startsWith("---\nid: TC-0101\ntitle:")).toBe(true);
  });

  it("따옴표·콜론이 든 제목도 왕복한다", () => {
    const a = parseTestcase(EXAMPLE_TC);
    if (!a.ok) throw new Error();
    const doc = { ...a.doc, frontMatter: { ...a.doc.frontMatter, title: `'가입': "확인" # 중요`, tags: ["a, b", "c"] } };
    const b = parseTestcase(serializeTestcase(doc));
    expect(b.ok && b.doc.frontMatter.title).toBe(`'가입': "확인" # 중요`);
    expect(b.ok && b.doc.frontMatter.tags).toEqual(["a, b", "c"]);
  });
});

describe("템플릿과 다음 id", () => {
  it("템플릿은 린트 오류가 없다(초안 상태)", () => {
    const text = testcaseTemplate({ id: "TC-0102", app: "demo", targets: ["ios"], account: "signup" });
    const r = lintTestcase(text, CTX);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.doc?.frontMatter).toMatchObject({ id: "TC-0102", status: "draft", account: "signup" });
  });

  it("앱과 상관없이 가장 큰 번호 + 1", () => {
    expect(nextTestcaseId(["TC-0002", "TC-0101", "TC-0099"])).toBe("TC-0102");
    expect(nextTestcaseId([])).toBe("TC-0001");
    expect(nextTestcaseId(["TC-12345"])).toBe("TC-12346");
  });
});

describe("린트 (PLAN 4.2)", () => {
  const rules = (text: string, ctx: LintContext = CTX) => lintTestcase(text, ctx).issues.map((i) => `${i.level}:${i.rule}`);

  it("예시 TC 는 문제 없다", () => {
    expect(rules(EXAMPLE_TC)).toEqual([]);
  });

  it("차단: 스텝 없음, 완료 기준 없음, 기대 없는 스텝, 없는 계정 역할", () => {
    const noSteps = EXAMPLE_TC.replace(/## 스텝[\s\S]*?(?=## 완료 기준)/, "## 스텝\n\n");
    expect(rules(noSteps)).toContain("error:steps-required");
    expect(rules(EXAMPLE_TC.replace(/## 완료 기준[\s\S]*$/, "## 완료 기준\n"))).toContain("error:done-required");
    const noExpected = EXAMPLE_TC.replace("   - 기대: 홈 화면이 열리고 '새 메모 작성'과 '설정 열기'가 보인다\n", "");
    const r = lintTestcase(noExpected, CTX);
    const stepLine = noExpected.split("\n").findIndex((l) => l.startsWith("2. ")) + 1;
    expect(r.issues).toContainEqual(expect.objectContaining({ level: "error", rule: "step-expected", step: 1, line: stepLine }));
    expect(hasBlocking(r.issues)).toBe(true);
    expect(rules(EXAMPLE_TC.replace("account: signup", "account: admin"))).toContain("error:account-role");
    // accounts.yaml 을 모르면 계정 규칙은 건너뛴다
    expect(rules(EXAMPLE_TC.replace("account: signup", "account: admin"), { accountRoles: null, appTargets: null })).toEqual([]);
  });

  it("경고: 앱 실행 스텝, 대상 없는 '선택한다·확인한다', app.yaml 에 없는 타깃", () => {
    const text = EXAMPLE_TC.replace("1. '이메일로 계속하기'를 탭한다", "1. 앱을 실행한다").replace("2. 새 이메일", "2. 결과를 확인한다\n   - 기대: x\n3. 새 이메일").replace("targets: [ios]", "targets: [ios, android]");
    const r = lintTestcase(text, CTX);
    expect(r.issues.map((i) => `${i.level}:${i.rule}:${i.step ?? ""}`)).toEqual(["warning:launch-step:0", "warning:vague-verb:1", "warning:target-unknown:"]);
    expect(hasBlocking(r.issues)).toBe(false);
    // 따옴표로 대상을 쓰면 모호하지 않다
    expect(rules(EXAMPLE_TC.replace("1. '이메일로 계속하기'를 탭한다", "1. '이메일로 계속하기'를 선택한다"))).toEqual([]);
  });

  it("front matter 오류는 차단으로 바뀐다", () => {
    expect(rules(EXAMPLE_TC.replace("status: active", "status: wip"))).toEqual(["error:front-matter"]);
  });
});
