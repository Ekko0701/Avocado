import { z } from "zod";
import { AppIdSchema } from "./builds";
import { WorkspaceSourceSchema } from "./settings";

/** 워크스페이스 저장소 연동 (PLAN 4장, T-110). 경로는 워크스페이스 기준 상대 경로다 */

export const WorkspaceStatusSchema = z.strictObject({
  /** 출처(ADR 0036). 화면은 이 칸으로 Git 요소를 숨긴다 */
  source: WorkspaceSourceSchema,
  connected: z.boolean(),
  /** owner/repo. 로컬이면 null */
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
  /** 폴더 구조(ADR 0032). 1: 종류별(testcases/, flows/), 2: 앱별(apps/<앱>/…). 연결 전이면 null */
  layout: z.union([z.literal(1), z.literal(2)]).nullable(),
  /** 화면에 보이는 로컬 워크스페이스 폴더(홈은 ~). GitHub 이면 null */
  location: z.string().nullable(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const SetWorkspaceSourceInputSchema = z.strictObject({ source: WorkspaceSourceSchema });

/** 원격이 필요한 기능을 로컬 워크스페이스에서 거절할 때의 안내(ADR 0036 결정 6). main 의 서비스가 모두 이 문장으로 거절한다 */
export function localWorkspaceRefusal(what: string): string {
  return `${what}: 이 Mac 에서 혼자 쓰는 로컬 워크스페이스에서는 쓸 수 없다. 설정에서 GitHub 사용을 켠다`;
}

/** 로컬 워크스페이스에만 있는 기능을 GitHub 워크스페이스에서 거절할 때의 안내 */
export function githubWorkspaceRefusal(what: string): string {
  return `${what}: GitHub 워크스페이스에서는 쓸 수 없다. 이 Mac 의 로컬 워크스페이스에서만 쓴다`;
}

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
  /** 머지 전인 내 가져오기 브랜치가 이 테스트 케이스를 바꿨다. 그동안은 고치지 않는다(ADR 0036 결정 11) */
  lockedBy: z.strictObject({ branch: z.string() }).nullable(),
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

/** main 또는 앱이 만드는 작업 브랜치 이름: TC 는 qa/<login>/<TC>-<요약>[-n], 앱 설정은 qa/<login>/app/<앱>/<요약>[-n](예전 이름 accounts/<앱>/… 도 같은 범위), 폴더 구조 바꾸기는 qa/<login>/workspace/<요약>[-n], 가져오기는 qa/<login>/import/<요약>[-n] */
export const WorkBranchNameSchema = z
  .string()
  .regex(
    /^(main|qa\/[A-Za-z0-9-]+\/TC-\d{4,}(-[a-z0-9-]+)?|qa\/[A-Za-z0-9-]+\/(app|accounts)\/[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9-]+|qa\/[A-Za-z0-9-]+\/(workspace|import)\/[a-z0-9-]+)$/,
    "작업 브랜치 이름 형식이 아니다",
  );

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
  /** 앱 설정(app.yaml·accounts.yaml) 브랜치면 그 앱 */
  appSettings: z.string().nullable(),
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

/** 앱 계정 역할 한 줄(apps/<앱>/accounts.yaml). 이름 규칙·사용 중인 역할·키 검사는 main 이 한다 */
export const AccountRoleEditSchema = z.strictObject({
  role: z.string().max(40),
  description: z.string().max(200),
  keys: z.array(z.string().max(64)).max(20),
});
export type AccountRoleEdit = z.infer<typeof AccountRoleEditSchema>;
/** 앱이 만드는 플로우 타깃(workspace 패키지의 TargetSchema 와 같은 값) */
export const AppTargetSchema = z.enum(["ios", "android", "flutter-ios", "flutter-android"]);
export const AppTargetEditSchema = z.strictObject({
  target: AppTargetSchema,
  appId: z.string().max(200),
  /** 프로젝트 폴더로 빌드할 때 팀이 같이 쓰는 스킴·구성(iOS). 비우면 없앤다 */
  scheme: z.string().max(200).nullable().optional(),
  configuration: z.string().max(200).nullable().optional(),
});
export type AppTargetEdit = z.infer<typeof AppTargetEditSchema>;
export const ReadAppSettingsInputSchema = z.strictObject({ app: AppIdSchema });
/** 앱 설정(apps/<앱>/app.yaml + accounts.yaml) 편집용 */
export const AppSettingsDocSchema = z.strictObject({
  app: z.string(),
  /** workspace.yaml 의 앱 목록에 있는가. 없으면 새 앱으로 만든다 */
  exists: z.boolean(),
  name: z.string(),
  locale: z.string().nullable(),
  targets: z.array(AppTargetEditSchema),
  roles: z.array(AccountRoleEditSchema),
  /** 읽은 곳: 이 앱의 진행 중인 앱 설정 브랜치. 없으면 null(지금 브랜치) */
  branch: z.string().nullable(),
});
export type AppSettingsDoc = z.infer<typeof AppSettingsDocSchema>;
export const SaveAppSettingsInputSchema = z.strictObject({
  app: AppIdSchema,
  /** 새 앱이면 true: workspace.yaml 앱 목록에 더하고 apps/<앱>/app.yaml 을 만든다 */
  create: z.boolean(),
  name: z.string().max(80),
  locale: z.string().max(20).nullable(),
  targets: z.array(AppTargetEditSchema).max(4),
  roles: z.array(AccountRoleEditSchema).max(50),
  /** 커밋 메시지와 브랜치 이름에 쓰는 짧은 설명 */
  summary: z.string().min(1).max(80),
});
export type SaveAppSettingsInput = z.infer<typeof SaveAppSettingsInputSchema>;
export const SaveAppSettingsResultSchema = SaveTestcaseResultSchema;
export type SaveAppSettingsResult = SaveTestcaseResult;

/** 공통 서브플로우 파일 이름(앱 플로우 폴더의 <타깃>/common/ 바로 아래). 경로 문자는 받지 않는다 */
export const SubflowNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.ya?ml$/, "서브플로우 파일 이름은 영문·숫자·-·_ 와 .yaml 이다");
export const SubflowSchema = z.strictObject({
  target: AppTargetSchema,
  name: z.string(),
  path: z.string(),
  text: z.string(),
  /** 같은 타깃에서 이 서브플로우를 runFlow 로 부르는 TC 플로우 */
  usedBy: z.array(z.string()),
});
export type Subflow = z.infer<typeof SubflowSchema>;
export const SubflowListSchema = z.strictObject({
  app: z.string(),
  /** 읽은 곳: 이 앱의 진행 중인 앱 설정 브랜치. 없으면 null(지금 브랜치) */
  branch: z.string().nullable(),
  subflows: z.array(SubflowSchema),
});
export type SubflowList = z.infer<typeof SubflowListSchema>;
export const SaveSubflowInputSchema = z.strictObject({
  app: AppIdSchema,
  target: AppTargetSchema,
  name: SubflowNameSchema,
  text: z.string().min(1).max(100_000),
  /** 커밋 메시지와 브랜치 이름에 쓰는 짧은 설명 */
  summary: z.string().min(1).max(80),
});
export type SaveSubflowInput = z.infer<typeof SaveSubflowInputSchema>;
export const SaveSubflowResultSchema = SaveTestcaseResultSchema;
export type SaveSubflowResult = SaveTestcaseResult;

export const TestcaseHistorySchema = z.array(
  z.strictObject({ commit: z.string(), date: z.iso.datetime({ offset: true }), author: z.string(), subject: z.string() }),
);
export type TestcaseHistory = z.infer<typeof TestcaseHistorySchema>;

/** 내 열린 PR(홈 화면, PLAN 12장) */
export const MyPullRequestSchema = z.strictObject({ number: z.number().int(), title: z.string(), url: z.string(), branch: z.string(), createdAt: z.string() });
export type MyPullRequest = z.infer<typeof MyPullRequestSchema>;

/**
 * 워크스페이스 내보내기·가져오기(ADR 0036 결정 11). 받은 파일은 남이 만든 것이라 main 이 풀지 않고 읽어 검사한 뒤
 * 항목마다 받는 쪽과 견준 미리보기를 보낸다. 화면은 고른 항목과 할 일만 돌려보낸다(경로·바이트는 main 에만 있다)
 */
export const TransferItemKindSchema = z.enum(["testcase", "app", "subflow"]);
export type TransferItemKind = z.infer<typeof TransferItemKindSchema>;
export const TransferItemStatusSchema = z.enum(["new", "renumber", "differs", "same", "rejected"]);
export type TransferItemStatus = z.infer<typeof TransferItemStatusSchema>;
/** 항목에 할 일: 새로 넣기, 같은 테스트로 덮어쓰기, 새 번호로 넣기, 이쪽 것 두기, 받은 것으로 바꾸기 */
export const TransferActionSchema = z.enum(["include", "overwrite", "renumber", "keep-ours", "take-theirs"]);
export type TransferAction = z.infer<typeof TransferActionSchema>;

export const TransferItemSchema = z.strictObject({
  /** 한 미리보기 안에서만 쓰는 이름 */
  key: z.string(),
  kind: TransferItemKindSchema,
  app: z.string(),
  /** 예: "TC-0001 → TC-0007 새 메모를 만든다", "공통 서브플로우 · launch-clean.yaml" */
  label: z.string(),
  /** 이름 아래 작은 글씨: 앱과 파일(예: "notes · 플로우 iOS") */
  detail: z.string(),
  status: TransferItemStatusSchema,
  /** "가져오면" 문장. 받지 않는 항목은 그 이유(줄 번호 포함) */
  note: z.string(),
  /** 고를 수 있는 할 일. 받지 않음·같음은 비어 있다 */
  choices: z.array(TransferActionSchema),
  /** 처음에 고른 할 일. null 이면 처음에는 고르지 않는다 */
  defaultChoice: TransferActionSchema.nullable(),
  /** 이 항목을 고르면 함께 들어가는 항목(앱 설정, 부르는 서브플로우) */
  requires: z.array(z.string()),
  /** 새 번호로 넣을 때의 번호(테스트 케이스). 그 밖에는 null */
  renumberTo: z.string().nullable(),
  /** 비교 보기: 내용이 다른 파일의 이쪽 것과 받은 것 */
  compare: z.array(z.strictObject({ path: z.string(), ours: z.string(), theirs: z.string() })),
});
export type TransferItem = z.infer<typeof TransferItemSchema>;

export const ImportSkippedSchema = z.strictObject({ path: z.string(), reason: z.string() });
export const ImportPreviewSchema = z.strictObject({
  importId: z.string(),
  /** 고른 zip·폴더 이름, 또는 "이 Mac 의 로컬 워크스페이스" */
  sourceLabel: z.string(),
  items: z.array(TransferItemSchema),
  /** 워크스페이스 파일 모양이 아니어서 건너뛴 파일과 그 이유. 조용히 빼지 않는다 */
  skipped: z.array(ImportSkippedSchema),
  summary: z.record(TransferItemStatusSchema, z.number().int().nonnegative()),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

/** zip·폴더 전체를 거절한 이유. 하나라도 있으면 아무것도 쓰지 않는다 */
export const ArchiveProblemCodeSchema = z.enum(["path", "name", "link", "type", "collision", "encrypted", "method", "size", "count", "format", "layout"]);
export type ArchiveProblemCode = z.infer<typeof ArchiveProblemCodeSchema>;
export const ArchiveProblemSchema = z.strictObject({ path: z.string(), code: ArchiveProblemCodeSchema, message: z.string() });
export type ArchiveProblem = z.infer<typeof ArchiveProblemSchema>;

export const ImportSourceSchema = z.enum(["file", "folder", "local-workspace"]);
export type ImportSource = z.infer<typeof ImportSourceSchema>;
/** 가져올 곳은 main 이 연 창에서 사람이 고른다. 로컬 워크스페이스는 GitHub 방식에서만 고른다 */
export const ImportPickInputSchema = z.strictObject({ from: ImportSourceSchema });
export const ImportPickResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("canceled") }),
  z.strictObject({ status: z.literal("rejected"), sourceLabel: z.string(), problems: z.array(ArchiveProblemSchema) }),
  z.strictObject({ status: z.literal("preview"), preview: ImportPreviewSchema }),
]);
export type ImportPickResult = z.infer<typeof ImportPickResultSchema>;

export const ImportApplyInputSchema = z.strictObject({
  importId: z.string().max(100),
  picks: z.array(z.strictObject({ key: z.string().max(300), action: TransferActionSchema })).max(5000),
});
export type ImportApplyInput = z.infer<typeof ImportApplyInputSchema>;
const RenumberedSchema = z.array(z.strictObject({ from: z.string(), to: z.string() }));
export const ImportApplyResultSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("local"), commit: z.string(), renumbered: RenumberedSchema }),
  z.strictObject({ source: z.literal("github"), branch: WorkBranchNameSchema, commit: z.string(), renumbered: RenumberedSchema }),
]);
export type ImportApplyResult = z.infer<typeof ImportApplyResultSchema>;
export const ImportCancelInputSchema = z.strictObject({ importId: z.string().max(100) });

/** 내보낼 내용. 로컬은 HEAD, GitHub 방식은 main(작업 브랜치의 승인 전 수정이 섞이지 않게) */
export const ExportInfoSchema = z.strictObject({
  apps: z.number().int().nonnegative(),
  testcases: z.number().int().nonnegative(),
  flows: z.number().int().nonnegative(),
  subflows: z.number().int().nonnegative(),
  ref: z.enum(["HEAD", "main"]),
  fileName: z.string(),
  appNames: z.array(z.string()),
  testcaseIds: z.array(z.string()),
});
export type ExportInfo = z.infer<typeof ExportInfoSchema>;
/** 저장한 zip 의 위치(홈은 ~). 저장 창을 닫으면 null */
export const ExportResultSchema = z.strictObject({ path: z.string() }).nullable();
export type ExportResult = z.infer<typeof ExportResultSchema>;
