import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlowFileError, isLiteralAppId, readFlowInfo } from "./flow-file";

const write = (text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "qa-flow-")), "TC-0002.yaml");
  writeFileSync(p, text);
  return p;
};

describe("플로우 머리", () => {
  it("이름, appId, 태그의 TC id 를 읽는다", () => {
    const info = readFlowInfo(write("appId: ${APP_ID}\nname: 학생 로그인\ntags: [smoke, TC-0002]\n---\n- launchApp\n"));
    expect(info).toMatchObject({ name: "학생 로그인", appId: "${APP_ID}", tcId: "TC-0002" });
    expect(isLiteralAppId(info.appId)).toBe(false);
  });

  it("이름이 없으면 파일 이름, TC id 는 이름에서도 찾고 없으면 adhoc", () => {
    expect(readFlowInfo(write("appId: a.b\n---\n- launchApp\n"))).toMatchObject({ name: "TC-0002", tcId: "TC-0002" });
    expect(readFlowInfo(write("appId: a.b\nname: 탐색\n---\n- launchApp\n")).tcId).toBe("adhoc");
  });

  it("명령 목록이 없거나 appId 가 없으면 오류", () => {
    expect(() => readFlowInfo(write("appId: a.b\n"))).toThrow(FlowFileError);
    expect(() => readFlowInfo(write("name: x\n---\n- launchApp\n"))).toThrow(/appId/);
    expect(() => readFlowInfo(write("appId: [a\n---\n- x\n"))).toThrow(FlowFileError);
  });
});
