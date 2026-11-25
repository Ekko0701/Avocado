import { describe, expect, it } from "vitest";
import { appIdFromName, defaultSubflowRows, emptyFirstApp, firstAppInput, firstAppProblems, withName, type FirstAppDraft } from "./app-form";

const draft = (over: Partial<FirstAppDraft> = {}): FirstAppDraft => {
  const base = emptyFirstApp();
  return { ...base, id: "notes", name: "Notes", targets: { ...base.targets, ios: { on: true, appId: "com.example.notes" } }, ...over };
};

describe("첫 앱 등록", () => {
  it("처음에는 iOS 만 켜져 있고 비어 있다", () => {
    const empty = emptyFirstApp();
    expect(empty.id).toBe("");
    expect(Object.entries(empty.targets).filter(([, t]) => t.on).map(([id]) => id)).toEqual(["ios"]);
  });

  it("앱 id 형식, 이미 있는 앱, 이름, 타깃의 앱 ID 를 본다", () => {
    expect(firstAppProblems(draft(), [])).toEqual([]);
    expect(firstAppProblems(draft({ id: "My App" }), [])).toContain("폴더·CLI 이름(앱 id)은 영문 소문자·숫자·하이픈만 씁니다");
    expect(firstAppProblems(draft(), ["notes"])).toContain("이미 있는 앱입니다: notes");
    expect(firstAppProblems(draft({ name: " " }), [])).toContain("앱 이름을 씁니다");
    const noAppId = draft();
    noAppId.targets = { ...noAppId.targets, ios: { on: true, appId: "" } };
    expect(firstAppProblems(noAppId, [])).toContain("iOS 앱 ID 를 공백 없이 씁니다");
    const none = draft();
    none.targets = { ...none.targets, ios: { on: false, appId: "com.example.notes" } };
    expect(firstAppProblems(none, [])).toContain("타깃을 하나 이상 고릅니다");
  });

  it("저장 입력은 새 앱이고 켠 타깃만, 언어·역할 없이 보낸다", () => {
    const d = draft({ id: " notes ", name: " Notes " });
    d.targets = { ...d.targets, android: { on: true, appId: " com.example.notes.android " }, "flutter-ios": { on: false, appId: "ignored" } };
    expect(firstAppInput(d)).toEqual({
      app: "notes",
      create: true,
      name: "Notes",
      locale: null,
      targets: [
        { target: "ios", appId: "com.example.notes" },
        { target: "android", appId: "com.example.notes.android" },
      ],
      roles: [],
      summary: "add app",
    });
  });

  it("함께 만드는 공통 서브플로우는 켠 타깃마다 셋이고, iOS 초기화는 시뮬레이터용이라고 알린다", () => {
    const d = draft();
    expect(defaultSubflowRows(d.targets).map((r) => `${r.label} ${r.path}`)).toEqual(["iOS common/launch-clean.yaml", "iOS common/dismiss-system-prompts.yaml", "iOS common/close-keyboard.yaml"]);
    expect(defaultSubflowRows(d.targets)[0]?.hint).toContain("시뮬레이터용입니다");
    d.targets = { ...d.targets, android: { on: true, appId: "x" } };
    const android = defaultSubflowRows(d.targets).filter((r) => r.target === "android");
    expect(android).toHaveLength(3);
    expect(android[0]?.hint).not.toContain("시뮬레이터");
  });
});

describe("앱 이름 → 폴더·CLI 이름(앱 id)", () => {
  it("영문 이름은 소문자·하이픈으로 바꾸고, 악센트는 떼고, 40자로 자른다", () => {
    expect(appIdFromName("Demo")).toBe("demo");
    expect(appIdFromName("  Demo Dev (QA) ")).toBe("demo-dev-qa");
    expect(appIdFromName("Café 2.0")).toBe("cafe-2-0");
    expect(appIdFromName("--My__App--")).toBe("my-app");
    const long = appIdFromName("a ".repeat(30));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("한글처럼 영문으로 바꿀 수 없는 글자가 있으면 만들지 않는다(사람이 쓴다)", () => {
    expect(appIdFromName("모먼트")).toBe("");
    expect(appIdFromName("모먼트 Dev")).toBe("");
    expect(appIdFromName("")).toBe("");
  });

  it("이름을 바꾸면 id 도 따라가고, 사람이 고친 id 는 그대로 둔다", () => {
    const start = { name: "", id: "", idEdited: false };
    expect(withName(start, "Demo Dev")).toEqual({ name: "Demo Dev", id: "demo-dev", idEdited: false });
    expect(withName({ name: "Demo", id: "demo-qa", idEdited: true }, "Demo Dev")).toEqual({ name: "Demo Dev", id: "demo-qa", idEdited: true });
  });
});
