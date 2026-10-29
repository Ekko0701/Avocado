import { z } from "zod";

/** 앱 내 새 버전 확인(PLAN 11장, T-116) */
export const UpdateStatusSchema = z.strictObject({
  current: z.string(),
  /** 새 버전을 확인하는 배포 저장소(owner/repo). 워크스페이스 조직과 상관없다 */
  source: z.string(),
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
  /** 받아서 재시작으로 적용하는 업데이트(ADR 0027). 할 수 없으면 .dmg 를 받아 연다 */
  autoInstall: z.strictObject({
    /** 릴리스에 이 Mac 용 .zip·.sha256 이 있고, 이 앱이 스스로 바꿔 끼울 수 있다 */
    possible: z.boolean(),
    /** possible 이 아닌 이유 */
    reason: z.string().nullable(),
    /** 받아서 확인을 마쳤다. 재시작하면 적용된다 */
    ready: z.boolean(),
  }),
  busy: z.boolean(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
