import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startUpdateFeed } from "./update-feed";

describe("Squirrel.Mac 피드 (ADR 0027)", () => {
  it("127.0.0.1 의 임의 경로에서 zip 주소와 zip 만 내주고, 닫으면 끝난다", async () => {
    const zip = join(mkdtempSync(join(tmpdir(), "qa-feed-")), "Avocado-0.2.0-arm64.zip");
    writeFileSync(zip, Buffer.from("zip bytes"));
    const feed = await startUpdateFeed(zip);
    try {
      expect(feed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/feed$/);
      const body = (await (await fetch(feed.url)).json()) as { url: string };
      expect(body.url).toBe(feed.url.replace(/\/feed$/, "/update.zip"));
      const file = await fetch(body.url);
      expect(file.headers.get("content-type")).toBe("application/zip");
      expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("zip bytes");
      // 토큰을 모르면 받을 수 없고, GET 말고는 받지 않는다
      const origin = new URL(feed.url).origin;
      expect((await fetch(`${origin}/update.zip`)).status).toBe(404);
      expect((await fetch(`${origin}/${"0".repeat(32)}/update.zip`)).status).toBe(404);
      expect((await fetch(body.url, { method: "POST" })).status).toBe(404);
    } finally {
      await feed.close();
    }
    await expect(fetch(feed.url)).rejects.toThrow();
  });
});
