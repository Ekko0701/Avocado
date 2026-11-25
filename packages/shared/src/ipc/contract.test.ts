import { describe, expect, it } from "vitest";
import { ipcChannels, ipcContract, isIpcChannel } from "./contract";

describe("ipcContract", () => {
  it("모든 채널은 '영역:동작' 이름을 쓴다", () => {
    for (const channel of ipcChannels) {
      expect(channel).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    }
  });

  it("알 수 없는 채널을 거부한다", () => {
    expect(isIpcChannel("app:ping")).toBe(true);
    expect(isIpcChannel("app:shell")).toBe(false);
    expect(isIpcChannel("constructor")).toBe(false);
    expect(isIpcChannel(42)).toBe(false);
  });

  it("ping 입력 길이와 모르는 필드를 거부한다", () => {
    const schema = ipcContract["app:ping"].input;
    expect(schema.safeParse({ message: "hello" }).success).toBe(true);
    expect(schema.safeParse({ message: "" }).success).toBe(false);
    expect(schema.safeParse({ message: "x".repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ message: "hi", extra: 1 }).success).toBe(false);
  });

  it("getInfo는 입력을 받지 않는다", () => {
    const schema = ipcContract["app:getInfo"].input;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse({ any: "thing" }).success).toBe(false);
  });

  it("workspace:reveal 은 경로를 받지 않는다(폴더는 main 이 안다)", () => {
    const schema = ipcContract["workspace:reveal"].input;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse({ path: "/etc" }).success).toBe(false);
    expect(schema.safeParse("/etc").success).toBe(false);
  });

  it("내보내기·가져오기는 렌더러에게서 경로를 받지 않는다(창은 main 이 연다)", () => {
    expect(ipcContract["workspace:export"].input.safeParse(undefined).success).toBe(true);
    expect(ipcContract["workspace:export"].input.safeParse({ path: "/tmp/x.zip" }).success).toBe(false);
    const pick = ipcContract["workspace:importPick"].input;
    expect(pick.safeParse({ from: "file" }).success).toBe(true);
    expect(pick.safeParse({ from: "local-workspace" }).success).toBe(true);
    expect(pick.safeParse({ from: "file", path: "/tmp/x.zip" }).success).toBe(false);
    expect(pick.safeParse({ from: "/tmp/x.zip" }).success).toBe(false);
    const apply = ipcContract["workspace:importApply"].input;
    expect(apply.safeParse({ importId: "a", picks: [{ key: "tc:demo:TC-0001", action: "include" }] }).success).toBe(true);
    expect(apply.safeParse({ importId: "a", picks: [{ key: "k", action: "delete" }] }).success).toBe(false);
    expect(apply.safeParse({ importId: "a", picks: [], path: "/tmp" }).success).toBe(false);
  });

  it("가져오기 브랜치 이름도 작업 브랜치로 받는다", () => {
    const schema = ipcContract["workspace:requestReview"].input;
    expect(schema.safeParse({ title: "t", body: "", branch: "qa/qa-bot/import/notes" }).success).toBe(true);
    expect(schema.safeParse({ title: "t", body: "", branch: "qa/qa-bot/import/../x" }).success).toBe(false);
  });
});
