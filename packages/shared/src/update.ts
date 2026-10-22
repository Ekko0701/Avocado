import { z } from "zod";

/** 앱 내 새 버전 확인(PLAN 11장, T-116) */
export const UpdateStatusSchema = z.strictObject({
  current: z.string(),
  latest: z.string().nullable(),
  available: z.boolean(),
  checkedAt: z.string().nullable(),
  release: z.strictObject({ tag: z.string(), name: z.string(), url: z.string(), publishedAt: z.string().nullable() }).nullable(),
  /** 이 Mac 에 맞는 .dmg */
  asset: z.strictObject({ name: z.string(), size: z.number().int().min(0) }).nullable(),
  error: z.string().nullable(),
  downloaded: z
    .strictObject({
      /** userData/updates 안의 파일 이름 */
      file: z.string(),
      /** SHA-256 이 릴리스의 .sha256 과 같다 */
      verified: z.boolean(),
      /** 서명·공증 확인(spctl). 아니면 열지 않고 Finder 로만 보여 준다 */
      signed: z.boolean(),
      opened: z.boolean(),
    })
    .nullable(),
  busy: z.boolean(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
