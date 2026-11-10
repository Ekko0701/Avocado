import { describe, expect, it } from "vitest";
import { layout, layoutForSchemaVersion } from "./layout";

describe("워크스페이스 폴더 구조 (ADR 0032)", () => {
  it("예전 구조(1): 종류별 폴더", () => {
    const l = layout(1);
    expect(l.testcasePath("demo", "TC-0101")).toBe("testcases/demo/TC-0101.md");
    expect(l.flowsDir("demo")).toBe("flows/demo");
    expect(l.flowPath("demo", "ios", "TC-0101")).toBe("flows/demo/ios/TC-0101.yaml");
    expect(l.metaPath("demo", "ios", "TC-0101")).toBe("flows/demo/ios/TC-0101.meta.yaml");
    expect(l.commonDir("demo", "android")).toBe("flows/demo/android/common");
    expect(l.parse("testcases/demo/TC-0101.md")).toEqual({ kind: "testcase", app: "demo", id: "TC-0101" });
    expect(l.parse("flows/demo/ios/TC-0101.meta.yaml")).toEqual({ kind: "flow", app: "demo", target: "ios", id: "TC-0101", meta: true });
    // 새 구조의 경로는 이 구조의 파일이 아니다
    expect(l.parse("apps/demo/testcases/TC-0101.md")).toBeNull();
  });

  it("새 구조(2): 앱별 폴더", () => {
    const l = layout(2);
    expect(l.testcaseDir("demo")).toBe("apps/demo/testcases");
    expect(l.testcasePath("demo", "TC-0101")).toBe("apps/demo/testcases/TC-0101.md");
    expect(l.flowDir("demo", "ios")).toBe("apps/demo/flows/ios");
    expect(l.flowPath("demo", "ios", "TC-0101")).toBe("apps/demo/flows/ios/TC-0101.yaml");
    expect(l.metaPath("demo", "ios", "TC-0101")).toBe("apps/demo/flows/ios/TC-0101.meta.yaml");
    expect(l.commonDir("demo", "ios")).toBe("apps/demo/flows/ios/common");
    expect(l.parse("apps/demo/testcases/TC-0101.md")).toEqual({ kind: "testcase", app: "demo", id: "TC-0101" });
    expect(l.parse("apps/demo/flows/ios/TC-0101.yaml")).toEqual({ kind: "flow", app: "demo", target: "ios", id: "TC-0101", meta: false });
    expect(l.parse("apps/demo/flows/flutter-android/common/launch-clean.yaml")).toEqual({ kind: "subflow", app: "demo", target: "flutter-android", name: "launch-clean.yaml" });
    expect(l.parse("testcases/demo/TC-0101.md")).toBeNull();
  });

  it("경로를 벗어나거나 모양이 다른 것은 받지 않는다", () => {
    for (const l of [layout(1), layout(2)]) {
      expect(l.parse(l.testcasePath("../x", "TC-0101"))).toBeNull();
      expect(l.parse(`${l.flowDir("demo", "web")}/TC-0101.yaml`)).toBeNull();
      expect(l.parse(`${l.flowDir("demo", "ios")}/../../x/TC-0101.yaml`)).toBeNull();
      expect(l.parse(`${l.commonDir("demo", "ios")}/sub/x.yaml`)).toBeNull();
      expect(l.parse(`${l.testcaseDir("demo")}/notes.md`)).toBeNull();
      expect(l.parse("apps/demo/app.yaml")).toBeNull();
    }
  });

  it("schemaVersion 이 2 일 때만 새 구조다", () => {
    expect(layoutForSchemaVersion(2).version).toBe(2);
    expect(layoutForSchemaVersion(1).version).toBe(1);
    expect(layoutForSchemaVersion(undefined).version).toBe(1);
    expect(layoutForSchemaVersion("2").version).toBe(1);
  });
});
