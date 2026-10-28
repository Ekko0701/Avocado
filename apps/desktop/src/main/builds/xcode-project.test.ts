import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtApps, countChanges, looksLikeXcodeProject, parseXcodebuildList, podsOutdated, xcodeLayout } from "./xcode-project";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-xcode-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 프로젝트 폴더를 흉내 낸다: 이름이 / 로 끝나면 폴더, 아니면 파일 */
function project(name: string, entries: string[]): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    if (entry.endsWith("/")) mkdirSync(join(root, entry), { recursive: true });
    else {
      mkdirSync(join(root, entry, ".."), { recursive: true });
      writeFileSync(join(root, entry), "");
    }
  }
  return root;
}

describe("xcodeLayout (ADR 0025)", () => {
  it(".xcodeproj 만 있는 폴더", () => {
    const root = project("Demo", ["Demo.xcodeproj/", "Sources/App.swift"]);
    expect(xcodeLayout(root)).toEqual({ root, container: { kind: "project", path: join(root, "Demo.xcodeproj") }, tools: [] });
  });

  it("CocoaPods 프로젝트는 .xcworkspace 를 고르고 pod 준비를 표시한다", () => {
    const root = project("Shop", ["Shop.xcodeproj/", "Shop.xcworkspace/", "Podfile"]);
    expect(xcodeLayout(root)).toMatchObject({ container: { kind: "workspace", path: join(root, "Shop.xcworkspace") }, tools: ["cocoapods"] });
  });

  it("Tuist·XcodeGen 프로젝트는 생성 전이면 컨테이너가 없어도 프로젝트로 본다", () => {
    const tuist = project("T", ["Project.swift", "Tuist/Config.swift"]);
    expect(xcodeLayout(tuist)).toEqual({ root: tuist, container: null, tools: ["tuist"] });
    expect(looksLikeXcodeProject(xcodeLayout(tuist))).toBe(true);
    const xcodegen = project("G", ["project.yml"]);
    expect(xcodeLayout(xcodegen).tools).toEqual(["xcodegen"]);
    expect(looksLikeXcodeProject(xcodeLayout(project("Empty", ["README.md"])))).toBe(false);
  });

  it(".xcworkspace·.xcodeproj 를 직접 고르면 그 폴더가 루트다", () => {
    const root = project("Pick", ["A.xcworkspace/", "B.xcodeproj/", "Podfile"]);
    expect(xcodeLayout(join(root, "B.xcodeproj"))).toEqual({ root, container: { kind: "project", path: join(root, "B.xcodeproj") }, tools: ["cocoapods"] });
  });

  it("여러 개면 폴더 이름과 같은 것, 아니면 이름순 첫 번째. 루트의 Pods.xcodeproj 는 고르지 않는다", () => {
    const named = project("Moon", ["Alpha.xcworkspace/", "Moon.xcworkspace/"]);
    expect(xcodeLayout(named).container?.path).toBe(join(named, "Moon.xcworkspace"));
    const other = project("Other", ["Zeta.xcodeproj/", "Beta.xcodeproj/", "Pods.xcodeproj/"]);
    expect(xcodeLayout(other).container?.path).toBe(join(other, "Beta.xcodeproj"));
    expect(xcodeLayout(project("OnlyPods", ["Pods.xcodeproj/"])).container).toBeNull();
  });
});

describe("podsOutdated", () => {
  it("Podfile 이 없으면 아니고, Manifest.lock 이 없거나 Podfile.lock 과 다르면 pod install 이 필요하다", () => {
    expect(podsOutdated(project("NoPods", ["Demo.xcodeproj/"]))).toBe(false);
    const root = project("Pods", ["Podfile"]);
    expect(podsOutdated(root)).toBe(true);
    writeFileSync(join(root, "Podfile.lock"), "PODS:\n  - A (1.0)\n");
    mkdirSync(join(root, "Pods"));
    writeFileSync(join(root, "Pods", "Manifest.lock"), "PODS:\n  - A (0.9)\n");
    expect(podsOutdated(root)).toBe(true);
    writeFileSync(join(root, "Pods", "Manifest.lock"), "PODS:\n  - A (1.0)\n");
    expect(podsOutdated(root)).toBe(false);
  });
});

describe("parseXcodebuildList", () => {
  it("프로젝트는 스킴과 구성, 워크스페이스는 스킴만", () => {
    expect(parseXcodebuildList(JSON.stringify({ project: { name: "Demo", schemes: ["Demo", "DemoTests"], configurations: ["Debug", "Release"], targets: ["Demo"] } }))).toEqual({
      schemes: ["Demo", "DemoTests"],
      configurations: ["Debug", "Release"],
    });
    expect(parseXcodebuildList(JSON.stringify({ workspace: { name: "Shop", schemes: ["Shop", "Pods-Shop"] } }))).toEqual({ schemes: ["Shop", "Pods-Shop"], configurations: [] });
  });

  it("JSON 앞의 경고 줄은 건너뛰고, JSON 이 없으면 오류", () => {
    const out = `2026-10-28 xcodebuild[1:2] [MT] DVTPlugInLoading: warning\n${JSON.stringify({ project: { schemes: ["A"], configurations: ["Debug"] } })}`;
    expect(parseXcodebuildList(out).schemes).toEqual(["A"]);
    expect(() => parseXcodebuildList("xcodebuild: error: no project")).toThrow(/JSON 이 없다/);
  });
});

describe("builtApps·countChanges", () => {
  it("결과 폴더 바로 아래의 .app 폴더만 이름순으로", () => {
    const products = project("Products", ["Demo.app/", "Demo.swiftmodule/", "Widget.app/", "notes.app"]);
    expect(builtApps(products)).toEqual([join(products, "Demo.app"), join(products, "Widget.app")]);
    expect(builtApps(join(dir, "none"))).toEqual([]);
  });

  it("git status --porcelain 의 변경 줄 수", () => {
    expect(countChanges("")).toBe(0);
    expect(countChanges(" M Sources/App.swift\n?? Notes.md\n")).toBe(2);
  });
});
