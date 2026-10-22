import { describe, expect, it } from "vitest";
import { exceptionMessage, isDriverFailure, stripAnsi } from "./console";
import { decodeXmlEntities, junitPassed, parseJUnit } from "./junit";
import { pngSize } from "./png";

describe("JUnit", () => {
  it("속성 엔티티, 자기 닫힘 testcase, failure 메시지 속성·CDATA 를 읽는다", () => {
    const xml = `<testsuites><testsuite name="s" device="Pixel &amp; co" tests="3">
      <testcase name="a &quot;q&quot;" time="1.5" status="SUCCESS"/>
      <testcase name="b" time="2"><failure message="boom &lt;1&gt;"/></testcase>
      <testcase name="c"><error><![CDATA[bad & worse]]></error></testcase>
    </testsuite></testsuites>`;
    const r = parseJUnit(xml);
    expect(r.device).toBe("Pixel & co");
    expect(r.cases).toEqual([
      { name: 'a "q"', status: "SUCCESS", timeSeconds: 1.5, failure: null },
      { name: "b", status: null, timeSeconds: 2, failure: "boom <1>" },
      { name: "c", status: null, timeSeconds: null, failure: "bad & worse" },
    ]);
    expect(r.cases.map(junitPassed)).toEqual([true, false, false]);
    expect(decodeXmlEntities("&#x41;&#66;&apos;")).toBe("AB'");
  });
});

describe("콘솔", () => {
  it("ANSI 색을 지우고 예외 메시지를 꺼낸다", () => {
    expect(stripAnsi("\u001b[1;31mFailed\u001b[0m")).toBe("Failed");
    expect(exceptionMessage("noise\nxcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready\n\tat a")).toBe("iOS driver not ready");
    expect(exceptionMessage("all good")).toBeNull();
  });

  it("Maestro 2.11.0 의 드라이버 시작 실패 예외를 알아본다(Android 포함)", () => {
    for (const cls of [
      "xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException",
      "maestro.MaestroDriverStartupException$AndroidDriverTimeoutException",
      "maestro.MaestroDriverStartupException$AndroidInstrumentationSetupFailure",
      "maestro.MaestroException$DriverTimeout",
      "maestro.MaestroException$IOSDeviceDriverSetupException",
    ]) {
      expect(isDriverFailure(`${cls}: x`)).toBe(true);
    }
    expect(isDriverFailure("maestro.MaestroException$ElementNotFound: x")).toBe(false);
  });
});

describe("PNG", () => {
  it("PNG 가 아니면 null", () => {
    expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
  });
});
