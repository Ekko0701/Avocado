import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pngSize } from "@qa/evidence";
import type { CommandRunner } from "../setup/command";

/** 모델에 보내는 캡처의 긴 변 상한(PLAN 8장) */
export const MAX_IMAGE_SIDE = 1000;


/**
 * macOS 기본 도구 sips 로 캡처를 줄인다(네이티브 모듈 없이). 이미 작으면 그대로 둔다.
 * 임시 파일은 앱 데이터 폴더 안에 두고 끝나면 지운다.
 */
export function createSipsShrinker(run: CommandRunner, tmpDir: string): (data: Buffer, mimeType: string) => Promise<{ data: Buffer; mimeType: string }> {
  return async (data, mimeType) => {
    const size = mimeType === "image/png" ? pngSize(data) : null;
    if (size && Math.max(size.width, size.height) <= MAX_IMAGE_SIDE) return { data, mimeType };
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const ext = mimeType === "image/jpeg" ? "jpg" : "png";
    const id = randomUUID();
    const input = join(tmpDir, `${id}-in.${ext}`);
    const output = join(tmpDir, `${id}-out.${ext}`);
    try {
      writeFileSync(input, data, { mode: 0o600 });
      const r = await run("/usr/bin/sips", ["-Z", String(MAX_IMAGE_SIDE), input, "--out", output], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`캡처 축소 실패(sips): ${r.stderr.trim().slice(0, 200)}`);
      return { data: readFileSync(output), mimeType };
    } finally {
      rmSync(input, { force: true });
      rmSync(output, { force: true });
    }
  };
}

/**
 * 증적 요약 묶음의 캡처 변환(PLAN 9.2): JPEG, 긴 변 maxSide, 품질 quality. sips 로 한다.
 */
export function createSipsJpegConverter(run: CommandRunner, tmpDir: string): (png: Buffer, options: { maxSide: number; quality: number }) => Promise<Buffer> {
  return async (png, { maxSide, quality }) => {
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const input = join(tmpDir, `${id}-in.png`);
    const output = join(tmpDir, `${id}-out.jpg`);
    try {
      writeFileSync(input, png, { mode: 0o600 });
      const r = await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(maxSide), input, "--out", output], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`캡처 변환 실패(sips): ${r.stderr.trim().slice(0, 200)}`);
      return readFileSync(output);
    } finally {
      rmSync(input, { force: true });
      rmSync(output, { force: true });
    }
  };
}
