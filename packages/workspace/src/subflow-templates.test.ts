import { describe, expect, it } from "vitest";
import { lintSubflow } from "./flow-lint";
import { TargetSchema } from "./schemas";
import { defaultSubflows } from "./subflow-templates";

describe("공통 서브플로우 기본 파일 (ADR 0036 결정 8)", () => {
  it.each(TargetSchema.options)("%s 기본 서브플로우는 서브플로우 규약을 문제 없이 통과한다", (target) => {
    const files = defaultSubflows(target);
    expect(files.map((f) => f.name)).toEqual(["launch-clean.yaml", "dismiss-system-prompts.yaml", "close-keyboard.yaml"]);
    for (const f of files) {
      const siblings = files.map((x) => x.name).filter((n) => n !== f.name);
      expect(lintSubflow(f.text, { envKeys: [], subflows: siblings })).toEqual([]);
    }
  });

  it("iOS 는 키체인까지 지우고 앱을 띄운다. Android 는 앱 상태만 지운다", () => {
    const launch = (target: "ios" | "android" | "flutter-ios" | "flutter-android") => defaultSubflows(target).find((f) => f.name === "launch-clean.yaml")?.text ?? "";
    for (const target of ["ios", "flutter-ios"] as const) expect(launch(target)).toMatch(/\n---\n- clearKeychain\n- launchApp:\n {4}clearState: true\n$/);
    for (const target of ["android", "flutter-android"] as const) expect(launch(target)).toMatch(/\n---\n- launchApp:\n {4}clearState: true\n$/);
  });
});
