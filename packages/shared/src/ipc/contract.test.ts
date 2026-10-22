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
});
