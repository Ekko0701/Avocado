import { z } from "zod";

/** GitHub 연결 확인 결과 (T-109). 토큰 값은 없다 */
export const RemoteVerifySchema = z.strictObject({
  login: z.string(),
  repos: z.array(z.strictObject({ owner: z.string(), repo: z.string(), exists: z.boolean(), canPush: z.boolean() })),
});
export type RemoteVerify = z.infer<typeof RemoteVerifySchema>;

/** 토큰으로 볼 수 있는 저장소(설정에서 저장소 이름을 고르기) */
export const RemoteRepoSchema = z.strictObject({ owner: z.string(), repo: z.string(), private: z.boolean(), canPush: z.boolean() });
export type RemoteRepo = z.infer<typeof RemoteRepoSchema>;
