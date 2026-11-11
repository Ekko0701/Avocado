import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findClaudeDoorayToken, QaDooray } from "./qa-dooray";

const ok = (result: unknown[]) => ({ status: 200, json: () => Promise.resolve({ header: { isSuccessful: true }, result }) });

describe("QaDooray", () => {
  it("토큰이 없으면 조회하지 않고 알린다", async () => {
    const dooray = new QaDooray({ token: () => null, fetch: () => Promise.reject(new Error("부르면 안 된다")) });
    await expect(dooray.projects()).rejects.toThrow("두레이 토큰을 먼저 저장한다");
  });

  it("프로젝트를 쪽마다 이어 받아 이름순으로 돌려준다", async () => {
    const urls: string[] = [];
    const first = Array.from({ length: 100 }, (_, i) => ({ id: String(i), code: `p${String(i).padStart(3, "0")}` }));
    const dooray = new QaDooray({
      token: () => "t",
      fetch: (url, init) => {
        urls.push(url);
        expect(init.headers["Authorization"]).toBe("dooray-api t");
        return Promise.resolve(ok(url.endsWith("page=0") ? first : [{ id: "x", code: "a-first" }]));
      },
    });
    const projects = await dooray.projects();
    expect(urls).toHaveLength(2);
    expect(projects).toHaveLength(101);
    expect(projects[0]).toEqual({ id: "x", name: "a-first" });
  });

  it("태그 이름만 돌려주고, 토큰이 틀리면 그렇게 알린다", async () => {
    const dooray = new QaDooray({ token: () => "t", fetch: () => Promise.resolve(ok([{ id: "1", name: "나" }, { id: "2", name: "가" }])) });
    expect(await dooray.tags("123")).toEqual(["가", "나"]);
    const denied = new QaDooray({ token: () => "t", fetch: () => Promise.resolve({ status: 401, json: () => Promise.resolve({}) }) });
    await expect(denied.tags("123")).rejects.toThrow("토큰이 맞지 않거나");
  });
});

describe("findClaudeDoorayToken", () => {
  it("Claude Code 설정에 등록된 두레이 토큰을 찾고, 없거나 깨진 파일이면 null 이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-dooray-"));
    const file = join(dir, "claude.json");
    expect(findClaudeDoorayToken(file)).toBeNull();
    writeFileSync(file, "{ 깨짐");
    expect(findClaudeDoorayToken(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" }, tracker: { env: { DOORAY_API_KEY: " abc " } } } }));
    expect(findClaudeDoorayToken(file)).toBe("abc");
  });
});
