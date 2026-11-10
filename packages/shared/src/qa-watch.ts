import { z } from "zod";
import { AppIdSchema } from "./builds";

/**
 * QA 티켓 자동 처리 설정(사이드 브랜치 side/qa-fix-monitor).
 * 이슈 트래커 프로젝트에 정한 태그가 붙은 티켓이 올라오면 Claude Code 가 알아서 처리하도록, 무엇을 언제 볼지 여기서 정한다.
 * Avocado 는 이슈 트래커를 직접 조회하지 않는다. 주기적으로 깨어난 Claude Code 가 qa_watch_next 로 이 설정을 받아 조회한다.
 */
export const QaWatchScopeSchema = z.enum(["all", "assigned_to_me"]);
export type QaWatchScope = z.infer<typeof QaWatchScopeSchema>;

export const QaWatchAppSchema = z.strictObject({
  id: z.string().min(1).max(64),
  /** 결과를 묶어 보는 앱 이름 */
  app: AppIdSchema,
  /** 이슈 트래커 프로젝트 이름(코드) */
  project: z.string().min(1).max(120),
  /** 이 태그가 붙은 티켓만 처리한다 */
  tag: z.string().min(1).max(60),
  /** all: 태그만 본다 · assigned_to_me: 그중 나에게 배정된 것만 */
  scope: QaWatchScopeSchema,
  /** 고칠 코드가 있는 이 Mac 의 저장소 폴더 */
  repoPath: z.string().min(1).max(1024),
  enabled: z.boolean(),
});
export type QaWatchApp = z.infer<typeof QaWatchAppSchema>;

export const QaWatchSettingsSchema = z
  .strictObject({
    /** 자동 처리 전체를 켜고 끈다 */
    enabled: z.boolean(),
    /** 새 티켓을 확인하는 간격(분) */
    intervalMinutes: z.number().int().min(5).max(1440),
    /** 확인하는 요일. 0(일) ~ 6(토) */
    days: z.array(z.number().int().min(0).max(6)).max(7),
    /** 확인을 시작하는 시(0~23)와 끝내는 시(1~24). 이 Mac 의 시각 기준 */
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
    /** 사람 확인 없이 MR 을 올려도 되는가 */
    autoMr: z.boolean(),
    /** 사람 확인 없이 티켓에 댓글을 달아도 되는가 */
    autoComment: z.boolean(),
    apps: z.array(QaWatchAppSchema).max(20),
  })
  .refine((v) => v.startHour < v.endHour, { message: "시작 시각이 끝 시각보다 앞이어야 한다" });
export type QaWatchSettings = z.infer<typeof QaWatchSettingsSchema>;

export const QaWatchStateSchema = z.strictObject({
  settings: QaWatchSettingsSchema,
  /** 마지막으로 새 티켓 확인을 넘겨준 시각 */
  lastCheckedAt: z.iso.datetime().nullable(),
});
export type QaWatchState = z.infer<typeof QaWatchStateSchema>;

export const DEFAULT_QA_WATCH_SETTINGS: QaWatchSettings = {
  enabled: false,
  intervalMinutes: 30,
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 18,
  autoMr: false,
  autoComment: false,
  apps: [],
};
