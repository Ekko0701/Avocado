import type { Build } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { buildLabel, buildOrigin, buildTime } from "./build-label";

const build = (over: Partial<Build>): Build => ({
  id: "b1",
  app: "demo",
  target: "ios",
  appId: "com.example.demo",
  version: "1.0",
  buildNumber: "1",
  commit: null,
  source: "file",
  path: "/tmp/b1/Demo.app",
  createdAt: "2026-11-09T06:20:34.769Z",
  label: null,
  ...over,
});

describe("빌드 이름", () => {
  it("버전이 같은 빌드도 스킴·구성과 만든 시각으로 구분된다", () => {
    const a = build({ id: "a", source: "project", label: "Demo · Debug", createdAt: "2026-11-09T05:39:38.270Z" });
    const b = build({ id: "b", source: "project", label: "Demo-Local · Debug" });
    expect(buildLabel(a)).toBe(`1.0 (1) · ${buildTime(a)} · Demo · Debug`);
    expect(buildLabel(b)).toBe(`1.0 (1) · ${buildTime(b)} · Demo-Local · Debug`);
    expect(buildLabel(a)).not.toBe(buildLabel(b));
    // 시각은 월·일·시·분만(짧게). 시간대는 이 Mac 을 따른다
    expect(buildTime(a)).toMatch(/^\d{1,2}\. \d{1,2}\. \d{2}:\d{2}$/);
  });

  it("이름표가 없으면 등록 방법을 쓰고, 커밋을 알면 앞 7자를 붙인다", () => {
    expect(buildOrigin(build({}))).toBe("파일로 등록");
    expect(buildOrigin(build({ source: "script", commit: "0123456789abcdef" }))).toBe("빌드 스크립트 · 0123456");
    expect(buildOrigin(build({ source: "project", label: "Demo · Release", commit: "93416c11f1e8769b" }))).toBe("Demo · Release · 93416c1");
  });
});
