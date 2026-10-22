import { z } from "zod";

/**
 * Maestro 2.11.0 산출물의 원본 형식. 쓰는 필드만 검증하고 나머지는 통과시킨다(새 버전이 필드를 더해도 깨지지 않게).
 * 형식이 다르면 예외를 내고, 빈 값으로 바꿔 통과시키지 않는다.
 */

export const MaestroStatusSchema = z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "WARNED", "SKIPPED"]);

const MaestroErrorSchema = z.union([
  z.object({ message: z.string(), debugMessage: z.string().nullish() }),
  z.string().transform((message) => ({ message, debugMessage: null })),
]);

export const MaestroCommandEntrySchema = z.object({
  /** 명령 이름 하나를 키로 갖는 객체. 예: { tapOnElement: {...} } */
  command: z.record(z.string(), z.unknown()).refine((c) => Object.keys(c).length === 1, "명령 객체에는 키가 하나여야 한다"),
  metadata: z.object({
    status: MaestroStatusSchema,
    timestamp: z.number().nullish(),
    duration: z.number().nullish(),
    sequenceNumber: z.number().int().nonnegative(),
    depth: z.number().int().nonnegative().nullish(),
    error: MaestroErrorSchema.nullish(),
    artifacts: z.array(z.object({ type: z.string(), path: z.string() })).nullish(),
    evaluatedCommand: z.record(z.string(), z.unknown()).nullish(),
  }),
});
export type MaestroCommandEntry = z.infer<typeof MaestroCommandEntrySchema>;

export const MaestroCommandsSchema = z.array(MaestroCommandEntrySchema);

export const MaestroManifestSchema = z.object({
  entries: z.array(
    z.object({
      kind: z.string(),
      format: z.string().nullish(),
      relativePath: z.string(),
      sizeBytes: z.number().nullish(),
      count: z.number().nullish(),
      metadata: z.record(z.string(), z.string()).nullish(),
    }),
  ),
});
export type MaestroManifest = z.infer<typeof MaestroManifestSchema>;

export const ApplyConfigurationSchema = z.object({
  config: z.object({ appId: z.string().nullish(), name: z.string().nullish() }).loose(),
});
