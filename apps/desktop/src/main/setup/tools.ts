import type { ToolId } from "@qa/shared";
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * 앱이 관리하는 도구의 고정 버전 (ADR 0006).
 * 버전을 올릴 때는 URL·SHA-256·크기를 공식 출처 두 곳(배포 API, 릴리스의 체크섬 파일)에서 교차 확인한다.
 */
export const ToolDefinitionSchema = z.strictObject({
  id: z.enum(["jre", "maestro"]),
  version: z.string().min(1),
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  archive: z.enum(["tar.gz", "zip"]),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const DEFAULT_TOOLS: Record<ToolId, ToolDefinition> = {
  jre: {
    id: "jre",
    version: "21.0.12.1+1",
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.12.1_1.tar.gz",
    sha256: "dec50fc6f9fcd4fe3ae8cabf5a5fa68f6afc48841f7698e468e9aa5d54beed84",
    sizeBytes: 47_185_920,
    archive: "tar.gz",
  },
  maestro: {
    id: "maestro",
    version: "2.11.0",
    url: "https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.11.0/maestro.zip",
    sha256: "5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a",
    sizeBytes: 314_886_578,
    archive: "zip",
  },
};

/**
 * 자동 E2E 가 로컬 서버의 가짜 도구를 쓰도록 정의를 바꿀 수 있다.
 * 패키징되지 않은 앱에서만 main 이 이 함수를 부른다(src/main/index.ts).
 */
export function loadToolOverrides(path: string | undefined): Record<ToolId, ToolDefinition> {
  if (!path) return DEFAULT_TOOLS;
  const parsed = z
    .strictObject({ jre: ToolDefinitionSchema, maestro: ToolDefinitionSchema })
    .parse(JSON.parse(readFileSync(path, "utf8")));
  return parsed;
}
