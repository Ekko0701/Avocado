import { z } from "zod";
import { AppIdSchema } from "./builds";

/** 워크스페이스 저장소 연동 (PLAN 4장, T-110). 경로는 워크스페이스 기준 상대 경로다 */

export const WorkspaceStatusSchema = z.strictObject({
  connected: z.boolean(),
  /** owner/repo */
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  onMain: z.boolean(),
  /** 커밋하지 않은 변경 파일 */
  dirty: z.array(z.string()),
  /** origin/main 대비 */
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  /** 워크스페이스 파일 검증 문제 수 */
  issues: z.number().int().nonnegative(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const WorkspaceIssueSchema = z.strictObject({ path: z.string(), line: z.number().int().positive().nullable(), message: z.string() });

export const TestcaseSummarySchema = z.strictObject({
  app: z.string(),
  id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  targets: z.array(z.string()),
  tags: z.array(z.string()),
  valid: z.boolean(),
  /** 플로우가 있는 타깃 */
  flows: z.array(z.string()),
});
export type TestcaseSummary = z.infer<typeof TestcaseSummarySchema>;

export const WorkspaceAppSchema = z.strictObject({
  app: z.string(),
  name: z.string(),
  /** app.yaml 의 타깃 */
  targets: z.array(z.string()),
  /** accounts.yaml 의 계정 역할 */
  accountRoles: z.array(z.string()),
});
export type WorkspaceApp = z.infer<typeof WorkspaceAppSchema>;

/**
 * 앱마다 필요한 테스트 계정 값(accounts.yaml 의 역할 → 설명·키 이름). 값은 없다.
 * 설정의 "테스트 계정 값"이 앱 ID·키 이름을 손으로 치지 않고 고르게 한다
 */
export const WorkspaceAccountsSchema = z.strictObject({
  connected: z.boolean(),
  apps: z.array(
    z.strictObject({
      app: z.string(),
      name: z.string(),
      roles: z.array(z.strictObject({ role: z.string(), description: z.string(), keys: z.array(z.string()) })),
    }),
  ),
});
export type WorkspaceAccounts = z.infer<typeof WorkspaceAccountsSchema>;

export const TestcaseListSchema = z.strictObject({
  testcases: z.array(TestcaseSummarySchema),
  apps: z.array(WorkspaceAppSchema),
  issues: z.array(WorkspaceIssueSchema),
});
export type TestcaseList = z.infer<typeof TestcaseListSchema>;

export const TestcaseRefSchema = z.strictObject({ app: AppIdSchema, id: z.string().regex(/^TC-\d{4,}$/) });
export const TestcaseTextSchema = z.strictObject({ path: z.string(), text: z.string() });

export const SaveTestcaseInputSchema = TestcaseRefSchema.extend({
  text: z.string().min(1).max(200_000),
  /** 커밋 메시지와 브랜치 이름에 쓰는 짧은 설명 */
  summary: z.string().min(1).max(80),
});
export const SaveTestcaseResultSchema = z.strictObject({ status: WorkspaceStatusSchema, branch: z.string(), commit: z.string() });
export type SaveTestcaseResult = z.infer<typeof SaveTestcaseResultSchema>;

/** main 또는 앱이 만드는 작업 브랜치 이름 qa/<login>/<TC>-<요약>[-n] */
export const WorkBranchNameSchema = z.string().regex(/^(main|qa\/[A-Za-z0-9-]+\/TC-\d{4,}(-[a-z0-9-]+)?)$/, "작업 브랜치 이름 형식이 아니다");

export const RequestReviewInputSchema = z.strictObject({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  /** 올릴 작업 브랜치. 없으면 지금 브랜치 */
  branch: WorkBranchNameSchema.optional(),
});
export const RequestReviewResultSchema = z.strictObject({
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
  /** 이 브랜치의 열린 PR 이 이미 있어 새 커밋만 올렸다 */
  existing: z.boolean(),
});
export type RequestReviewResult = z.infer<typeof RequestReviewResultSchema>;

/** 내 작업 브랜치(qa/<login>/…). TC 하나에 브랜치 하나, PR 하나 */
export const WorkBranchSchema = z.strictObject({
  name: z.string(),
  tcId: z.string().nullable(),
  current: z.boolean(),
  /** main 에 없는 커밋 수 */
  ahead: z.number().int().nonnegative(),
  /** 마지막 커밋 제목 */
  subject: z.string(),
  /** main 에 아직 없는 변경이 있다. false 면 머지됐거나(스쿼시 포함) 빈 브랜치다 */
  pending: z.boolean(),
});
export type WorkBranch = z.infer<typeof WorkBranchSchema>;
export const WorkBranchListSchema = z.strictObject({ current: z.string().nullable(), branches: z.array(WorkBranchSchema) });
export type WorkBranchList = z.infer<typeof WorkBranchListSchema>;
export const CheckoutInputSchema = z.strictObject({ branch: WorkBranchNameSchema });

export const TestcaseHistorySchema = z.array(
  z.strictObject({ commit: z.string(), date: z.iso.datetime({ offset: true }), author: z.string(), subject: z.string() }),
);
export type TestcaseHistory = z.infer<typeof TestcaseHistorySchema>;

/** 내 열린 PR(홈 화면, PLAN 12장) */
export const MyPullRequestSchema = z.strictObject({ number: z.number().int(), title: z.string(), url: z.string(), branch: z.string(), createdAt: z.string() });
export type MyPullRequest = z.infer<typeof MyPullRequestSchema>;
