import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../setup/command";
import { pngSize } from "@qa/evidence";
import { createSipsJpegConverter, createSipsShrinker, MAX_IMAGE_SIDE } from "./image";

const FIXTURE = resolve(__dirname, "../../../../../packages/evidence/fixtures/ios-pass/maestro/2026-10-21_232346/fixture iOS 설정 검색/takeScreenshot/01_search_typed.png");

describe("캡처 축소(sips)", () => {
  it("긴 변을 1,000px 이하로 줄이고, 이미 작으면 그대로 둔다. 임시 파일은 남기지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-image-"));
    const small = join(dir, "small.png");
    copyFileSync(FIXTURE, small);
    const big = join(dir, "big.png");
    // 시뮬레이터 캡처 크기 정도로 키운다
    execFileSync("/usr/bin/sips", ["-z", "2622", "1206", small, "--out", big], { stdio: "ignore" });
    expect(pngSize(readFileSync(big))).toEqual({ width: 1206, height: 2622 });

    const tmp = join(dir, "tmp");
    const shrink = createSipsShrinker(runCommand, tmp);
    const out = await shrink(readFileSync(big), "image/png");
    const size = pngSize(out.data);
    expect(out.mimeType).toBe("image/png");
    expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBe(MAX_IMAGE_SIDE);
    expect(readdirSync(tmp)).toEqual([]);

    const same = readFileSync(small);
    expect((await shrink(same, "image/png")).data).toBe(same);
  });

  it("요약 묶음 캡처: JPEG, 긴 변 720px", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-jpeg-"));
    const big = join(dir, "big.png");
    execFileSync("/usr/bin/sips", ["-z", "2622", "1206", FIXTURE, "--out", big], { stdio: "ignore" });
    const jpeg = await createSipsJpegConverter(runCommand, join(dir, "tmp"))(readFileSync(big), { maxSide: 720, quality: 70 });
    expect(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    const out = join(dir, "out.jpg");
    writeFileSync(out, jpeg);
    const dims = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]).toString();
    expect(dims).toMatch(/pixelHeight: 720/);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });
});
