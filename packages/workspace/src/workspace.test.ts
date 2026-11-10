import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutOf, loadWorkspace } from "./load";
import { toLegacyLayout } from "./testing/legacy-layout";
import { parseTestcase } from "./testcase";

const EXAMPLE = resolve(__dirname, "../../../examples/qa-workspace");

const TC = `---
id: TC-0101
title: 가입
app: demo
targets: [ios]
status: active
---
## 전제조건
- 서버 실행 중
## 스텝
1. '이메일로 계속하기'를 탭한다
   - 기대: 가입 화면
   - 기대: 가입하기 버튼
2. 입력하고
   '가입하기'를 탭한다
   - 기대: 홈 화면
## 완료 기준
- 새 메모 작성
## 메모
- 자유 형식
`;

describe("TC 파일", () => {
  it("front matter 와 전제조건·스텝(기대)·완료 기준을 읽는다", () => {
    const r = parseTestcase(TC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.frontMatter).toMatchObject({ id: "TC-0101", app: "demo", targets: ["ios"], status: "active" });
    expect(r.doc.preconditions).toEqual(["서버 실행 중"]);
    expect(r.doc.steps).toEqual([
      { action: "'이메일로 계속하기'를 탭한다", expected: ["가입 화면", "가입하기 버튼"], line: 11 },
      { action: "입력하고 '가입하기'를 탭한다", expected: ["홈 화면"], line: 14 },
    ]);
    expect(r.doc.doneCriteria).toEqual(["새 메모 작성"]);
    expect(r.doc.otherSections).toEqual(["메모"]);
  });

  it("front matter 가 없거나 잘못되면 위치와 함께 알린다", () => {
    expect(parseTestcase("## 스텝\n1. x")).toMatchObject({ ok: false, issues: [{ line: 1 }] });
    expect(parseTestcase("---\nid: TC-1\n")).toMatchObject({ ok: false, issues: [{ message: expect.stringContaining("닫는 ---") }] });
    const bad = parseTestcase(TC.replace("id: TC-0101", "id: TC-1").replace("status: active", "status: done"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.message).join("\n")).toMatch(/id.*TC-0001[\s\S]*status/);
    expect(parseTestcase("---\nid: [\n---\n").ok).toBe(false);
  });
});

describe("워크스페이스 읽기", () => {
  it("예시 워크스페이스(템플릿)는 문제가 없다", () => {
    const ws = loadWorkspace(EXAMPLE);
    expect(ws.issues).toEqual([]);
    expect(ws.layout.version).toBe(2);
    expect(ws.testcases.map((t) => t.path)).toEqual(["apps/demo/testcases/TC-0101.md", "apps/sample/testcases/TC-0002.md"]);
    expect(ws.flows.map((f) => f.path)).toContain("apps/demo/flows/ios/common/launch-clean.yaml");
    expect(ws.config?.apps).toEqual(["demo", "sample"]);
    expect(ws.apps["demo"]?.config?.targets.ios?.appId).toBe("com.example.demo");
    expect(ws.apps["demo"]?.accounts).toEqual({ signup: { description: expect.any(String), keys: ["DEMO_TEST_PASSWORD"] } });
    expect(ws.testcases.map((t) => `${t.app}/${t.id}`)).toEqual(["demo/TC-0101", "sample/TC-0002"]);
    expect(ws.flows.find((f) => f.tcId === "TC-0101")).toMatchObject({ app: "demo", target: "ios", meta: { generatedBy: "human" } });
    expect(ws.flows.filter((f) => f.tcId === null).length).toBe(4);
  });

  it("잘못된 파일은 버리지 않고 목록에 남기며 문제를 경로와 함께 모은다", () => {
    const root = join(mkdtempSync(join(tmpdir(), "qa-ws-")), "ws");
    cpSync(EXAMPLE, root, { recursive: true });
    try {
      writeFileSync(join(root, "apps", "demo", "testcases", "TC-0102.md"), TC.replace("status: active", "status: ???"));
      writeFileSync(join(root, "apps", "demo", "testcases", "TC-0103.md"), TC); // id 가 파일 이름과 다르다
      writeFileSync(join(root, "apps", "demo", "testcases", "notes.md"), TC.replace("TC-0101", "TC-0104"));
      mkdirSync(join(root, "apps", "ghost", "testcases"), { recursive: true });
      mkdirSync(join(root, "apps", "demo", "flows", "web"));
      writeFileSync(join(root, "apps", "demo", "flows", "ios", "TC-0101.meta.yaml"), "tc: TC-0101\n");
      writeFileSync(join(root, "apps", "sample", "accounts.yaml"), "Student:\n  description: x\n  keys: [lower_case]\n");
      const ws = loadWorkspace(root);
      const byPath = (p: string) => ws.issues.filter((i) => i.path === p).map((i) => i.message).join(" | ");
      expect(byPath("apps/demo/testcases/TC-0102.md")).toMatch(/status/);
      expect(ws.testcases.find((t) => t.id === "TC-0102")?.doc).toBeNull();
      expect(byPath("apps/demo/testcases/TC-0103.md")).toMatch(/파일 이름과 다르다/);
      expect(byPath("apps/demo/testcases/notes.md")).toMatch(/TC-0001\.md 형식/);
      expect(byPath("apps/ghost/testcases")).toMatch(/apps 에 없는 앱/);
      expect(byPath("apps/demo/flows/web")).toMatch(/타깃 폴더/);
      expect(byPath("apps/demo/flows/ios/TC-0101.meta.yaml")).toMatch(/tcVersion|target|generatedBy/);
      expect(byPath("apps/sample/accounts.yaml")).toMatch(/키 이름[\s\S]*역할 이름|역할 이름[\s\S]*키 이름/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("예전 구조(schemaVersion 1)도 그대로 읽는다 (ADR 0032)", () => {
    const root = join(mkdtempSync(join(tmpdir(), "qa-ws-v1-")), "ws");
    cpSync(EXAMPLE, root, { recursive: true });
    try {
      toLegacyLayout(root);
      expect(layoutOf(root).version).toBe(1);
      const ws = loadWorkspace(root);
      expect(ws.issues).toEqual([]);
      expect(ws.layout.version).toBe(1);
      expect(ws.testcases.map((t) => t.path)).toEqual(["testcases/demo/TC-0101.md", "testcases/sample/TC-0002.md"]);
      expect(ws.flows.find((f) => f.tcId === "TC-0101")).toMatchObject({ path: "flows/demo/ios/TC-0101.yaml", meta: { generatedBy: "human" } });
      expect(ws.flows.filter((f) => f.tcId === null).length).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("다른 구조의 자리에 남은 폴더는 읽지 않고 문제로 알린다", () => {
    const root = join(mkdtempSync(join(tmpdir(), "qa-ws-mixed-")), "ws");
    cpSync(EXAMPLE, root, { recursive: true });
    try {
      // 새 구조인데 예전 위치에 폴더가 있다
      mkdirSync(join(root, "testcases", "demo"), { recursive: true });
      writeFileSync(join(root, "testcases", "demo", "TC-0109.md"), TC.replace("TC-0101", "TC-0109"));
      mkdirSync(join(root, "flows"));
      const v2 = loadWorkspace(root);
      expect(v2.issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
        "testcases: 예전 위치의 폴더다. 새 구조(schemaVersion 2)에서는 apps/<앱>/testcases 에 둔다",
        "flows: 예전 위치의 폴더다. 새 구조(schemaVersion 2)에서는 apps/<앱>/flows 에 둔다",
      ]);
      expect(v2.testcases.map((t) => t.id)).not.toContain("TC-0109");
      // 예전 구조인데 새 위치에 폴더가 있다
      rmSync(join(root, "testcases"), { recursive: true });
      rmSync(join(root, "flows"), { recursive: true });
      toLegacyLayout(root);
      mkdirSync(join(root, "apps", "demo", "testcases"));
      const v1 = loadWorkspace(root);
      expect(v1.issues.map((i) => i.path)).toEqual(["apps/demo/testcases"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("workspace.yaml 이 없으면 알린다", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-ws-empty-"));
    expect(loadWorkspace(root).issues).toEqual([{ path: "workspace.yaml", line: null, message: "workspace.yaml 이 없다" }]);
  });
});
