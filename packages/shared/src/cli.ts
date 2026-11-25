import { z } from "zod";

/**
 * 설정의 "터미널" 구역(T-122, ADR 0035 결정 6·D19). 앱 번들의 avocado 명령과 PATH 에 거는 명령.
 * 앱은 앱 데이터 밖에 쓰지 않는다. 걸기는 사람이 터미널에서 한다
 */
export const CliInfoSchema = z.strictObject({
  /** 이 앱 번들에 avocado 명령이 있다(패키징한 앱). 개발 실행이면 false 이고 pnpm avocado 를 쓴다 */
  available: z.boolean(),
  /** 번들의 셸 스크립트 경로(Contents/Resources/bin/avocado) */
  scriptPath: z.string().nullable(),
  /** 거는 자리. 보여 줄 때는 ~ 로 줄인다 */
  linkPath: z.string(),
  /** this: 이 앱의 명령을 가리킨다, other: 다른 파일·다른 앱을 가리킨다, none: 없다 */
  link: z.enum(["this", "other", "none"]),
  /** 터미널에 붙여 넣을 명령. 명령이 없으면 null */
  linkCommand: z.string().nullable(),
});
export type CliInfo = z.infer<typeof CliInfoSchema>;
