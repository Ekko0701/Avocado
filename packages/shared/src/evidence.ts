import { z } from "zod";

/** 실행 증적 열람 (PLAN 12장 결과 화면, T-108). 경로는 실행의 가린 사본(redacted) 기준 상대 경로다. */

export const ExecutionRefSchema = z.strictObject({ runId: z.string().min(1), executionId: z.string().min(1) });
export const EvidenceRefSchema = ExecutionRefSchema.extend({ path: z.string().min(1).max(1024) });

export const EvidenceArtifactSchema = z.strictObject({
  kind: z.enum([
    "console_log",
    "junit",
    "command_metadata",
    "manifest",
    "maestro_log",
    "device_log",
    "runner_log",
    "take_screenshot",
    "failure_screenshot",
    "screen_hierarchy",
    "other",
  ]),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().nullable(),
  image: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const EvidenceFileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), path: z.string(), mime: z.enum(["image/png", "image/jpeg"]), dataUrl: z.string(), bytes: z.number().int() }),
  z.strictObject({
    kind: z.literal("text"),
    path: z.string(),
    text: z.string(),
    /** 파일이 커서 끝부분만 보냈다 */
    truncated: z.boolean(),
    /** text 첫 줄의 원래 줄 번호(1부터) */
    firstLine: z.number().int().positive(),
    bytes: z.number().int(),
  }),
]);
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

export const EvidenceSearchInputSchema = ExecutionRefSchema.extend({ query: z.string().min(1).max(200) });
export const EvidenceSearchResultSchema = z.strictObject({
  matches: z.array(z.strictObject({ path: z.string(), line: z.number().int().positive(), text: z.string() })),
  /** 결과가 많아 일부만 보냈다 */
  truncated: z.boolean(),
});
export type EvidenceSearchResult = z.infer<typeof EvidenceSearchResultSchema>;

export const HierarchyNodeSchema = z.strictObject({
  depth: z.number().int().nonnegative(),
  text: z.string(),
  id: z.string(),
  className: z.string(),
  bounds: z.string(),
  enabled: z.boolean(),
});
export const HierarchyViewSchema = z.strictObject({ nodes: z.array(HierarchyNodeSchema), truncated: z.boolean() });
export type HierarchyView = z.infer<typeof HierarchyViewSchema>;

/** 증적 요약 묶음 업로드(PLAN 9.2~9.4, T-114) */
export const PrepareUploadInputSchema = ExecutionRefSchema.extend({ includePassScreens: z.boolean() });
export type PrepareUploadInput = z.infer<typeof PrepareUploadInputSchema>;

export const UploadPreviewSchema = z.strictObject({
  /** 업로드에 넘길 값. 비밀 값이 남아 막혔으면 null */
  bundleId: z.string().nullable(),
  /** 올라갈 저장소(owner/repo)와 묶음 폴더 */
  repo: z.string(),
  root: z.string(),
  files: z.array(z.strictObject({ path: z.string(), kind: z.enum(["run_json", "report", "screen", "failure_screen", "hierarchy", "log"]), bytes: z.number().int().min(0) })),
  /** 캡처 미리보기(data URL) */
  thumbnails: z.array(z.strictObject({ path: z.string(), dataUrl: z.string() })).max(50),
  totalBytes: z.number().int().min(0),
  warnings: z.array(z.string()),
  blocked: z.boolean(),
  /** 비밀 값이 남은 파일(경로와 개수만) */
  residue: z.array(z.strictObject({ path: z.string(), occurrences: z.number().int(), inPath: z.boolean(), patternMatches: z.number().int() })),
});
export type UploadPreview = z.infer<typeof UploadPreviewSchema>;

export const UploadInputSchema = z.strictObject({
  bundleId: z.string().min(1).max(100),
  /** "개인정보 확인함" 체크(9.3 의 3) */
  privacyConfirmed: z.literal(true),
});

export const UploadRecordSchema = z.strictObject({
  repo: z.string(),
  path: z.string(),
  commitSha: z.string(),
  /** report.md 의 GitHub 주소 */
  url: z.string(),
  bytes: z.number().int().min(0),
  uploadedAt: z.string(),
});
export type UploadRecord = z.infer<typeof UploadRecordSchema>;
