import { z } from "zod";
import { UpdateStatusSchema, type UpdateStatus } from "../update";
import { AgentJobRefSchema, AgentUsageSchema, AuthorJobSchema, ClaudeConnectionSchema, ClaudeJudgeJobSchema, JudgementSchema, StartAuthorInputSchema, type AgentUsage, type AuthorJob, type ClaudeConnection, type ClaudeJudgeJob, type Judgement, type StartAuthorInput } from "../agent";
import {
  SecretNameSchema,
  SecretStatusSchema,
  SecretsListSchema,
  SecretValueSchema,
  SettingsPatchSchema,
  SettingsSchema,
  SettingsStateSchema,
  type SecretName,
  type SecretStatus,
  type SecretsList,
  type Settings,
  type SettingsPatch,
  type SettingsState,
} from "../settings";
import {
  InstallProgressSchema,
  InstallToolInputSchema,
  MaestroVerifySchema,
  SetupReportSchema,
  ToolStatusSchema,
  type InstallProgress,
  type MaestroVerify,
  type SetupReport,
  type ToolId,
  type ToolStatus,
} from "../setup";
import {
  DeviceListSchema,
  DeviceRefSchema,
  DeviceSchema,
  PrepareAndroidInputSchema,
  PrepareIosInputSchema,
  type Device,
  type DeviceList,
} from "../devices";
import {
  BuildSchema,
  InstallBuildInputSchema,
  InstallResultSchema,
  PickBuildInputSchema,
  RunBuildScriptInputSchema,
  type Build,
  type InstallResult,
} from "../builds";
import {
  PickedFlowSchema,
  RunDetailSchema,
  RunRefSchema,
  RunSummarySchema,
  StartRunInputSchema,
  type PickedFlow,
  type RunDetail,
  type RunSummary,
  type StartRunInput,
  SetKeepInputSchema,
  StartFromWorkspaceInputSchema,
  RunQueueStatusSchema,
  type StartFromWorkspaceInput,
  type RunQueueStatus,
} from "../runs";
import {
  EvidenceArtifactSchema,
  EvidenceFileSchema,
  EvidenceRefSchema,
  EvidenceSearchInputSchema,
  EvidenceSearchResultSchema,
  ExecutionRefSchema,
  HierarchyViewSchema,
  type EvidenceArtifact,
  type EvidenceFile,
  type EvidenceSearchResult,
  type HierarchyView,
  PrepareUploadInputSchema,
  UploadPreviewSchema,
  UploadInputSchema,
  UploadRecordSchema,
  type PrepareUploadInput,
  type UploadPreview,
  type UploadRecord,
} from "../evidence";
import { RemoteRepoSchema, RemoteVerifySchema, type RemoteRepo, type RemoteVerify } from "../remote";
import {
  RequestReviewInputSchema,
  RequestReviewResultSchema,
  SaveTestcaseInputSchema,
  SaveTestcaseResultSchema,
  TestcaseHistorySchema,
  TestcaseListSchema,
  TestcaseRefSchema,
  WorkspaceAccountsSchema,
  TestcaseTextSchema,
  WorkspaceStatusSchema,
  type RequestReviewResult,
  type SaveTestcaseResult,
  type TestcaseHistory,
  type TestcaseList,
  type WorkspaceAccounts,
  type WorkspaceStatus,
  MyPullRequestSchema,
  type MyPullRequest,
  CheckoutInputSchema,
  AppSettingsDocSchema,
  ReadAppSettingsInputSchema,
  SaveAppSettingsInputSchema,
  SaveAppSettingsResultSchema,
  type AppSettingsDoc,
  type SaveAppSettingsInput,
  type SaveAppSettingsResult,
  WorkBranchListSchema,
  type WorkBranchList,
} from "../workspace";

/**
 * 렌더러와 main 사이의 모든 IPC 채널 정의.
 * - main은 입력과 출력을 이 스키마로 검증한다(렌더러는 신뢰하지 않는다).
 * - preload는 여기 있는 채널만 노출한다.
 * - 비밀 값을 main 에서 렌더러로 보내는 채널은 만들지 않는다(CLAUDE.md 5장).
 * 채널을 추가할 때는 이 파일, main 핸들러, preload API, 테스트를 함께 고친다.
 */

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  versions: z.object({
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
  }),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const PingInputSchema = z.strictObject({
  message: z.string().min(1).max(200),
});
export const PingOutputSchema = z.object({
  message: z.string(),
  receivedAt: z.iso.datetime(),
});

export const DbStatusSchema = z.strictObject({
  path: z.string(),
  schemaVersion: z.number().int().min(0),
  latestVersion: z.number().int().min(0),
  journalMode: z.string(),
  tables: z.array(z.string()),
});
export type DbStatus = z.infer<typeof DbStatusSchema>;

export const SecretSetInputSchema = z.strictObject({ name: SecretNameSchema, value: SecretValueSchema });
export const SecretDeleteInputSchema = z.strictObject({ name: SecretNameSchema });

export const ipcContract = {
  "app:getInfo": { input: z.undefined(), output: AppInfoSchema },
  "app:ping": { input: PingInputSchema, output: PingOutputSchema },
  "app:openExternal": { input: z.strictObject({ url: z.string().min(1).max(2048) }), output: z.strictObject({ opened: z.literal(true) }) },
  "settings:get": { input: z.undefined(), output: SettingsStateSchema },
  "settings:update": { input: SettingsPatchSchema, output: SettingsSchema },
  "secrets:list": { input: z.undefined(), output: SecretsListSchema },
  "secrets:set": { input: SecretSetInputSchema, output: SecretStatusSchema },
  "secrets:delete": { input: SecretDeleteInputSchema, output: SecretStatusSchema },
  "db:status": { input: z.undefined(), output: DbStatusSchema },
  "setup:check": { input: z.undefined(), output: SetupReportSchema },
  "setup:installTool": { input: InstallToolInputSchema, output: ToolStatusSchema },
  "setup:progress": { input: z.undefined(), output: InstallProgressSchema },
  "setup:verifyMaestro": { input: z.undefined(), output: MaestroVerifySchema },
  "setup:complete": { input: z.undefined(), output: SettingsSchema },
  "devices:list": { input: z.undefined(), output: DeviceListSchema },
  "devices:prepareIos": { input: PrepareIosInputSchema, output: DeviceSchema },
  "devices:prepareAndroid": { input: PrepareAndroidInputSchema, output: DeviceSchema },
  "devices:shutdown": { input: DeviceRefSchema, output: DeviceSchema },
  "builds:list": { input: z.undefined(), output: z.array(BuildSchema) },
  "builds:pickAndRegister": { input: PickBuildInputSchema, output: BuildSchema.nullable() },
  "builds:runScript": { input: RunBuildScriptInputSchema, output: BuildSchema.nullable() },
  "builds:install": { input: InstallBuildInputSchema, output: InstallResultSchema },
  "runs:pickFlow": { input: z.undefined(), output: PickedFlowSchema.nullable() },
  "runs:start": { input: StartRunInputSchema, output: RunSummarySchema },
  "runs:list": { input: z.undefined(), output: z.array(RunSummarySchema) },
  "runs:get": { input: RunRefSchema, output: RunDetailSchema },
  "runs:cancel": { input: RunRefSchema, output: RunSummarySchema },
  "runs:setKeep": { input: SetKeepInputSchema, output: RunSummarySchema },
  "runs:startFromWorkspace": { input: StartFromWorkspaceInputSchema, output: RunQueueStatusSchema },
  "runs:queue": { input: z.undefined(), output: RunQueueStatusSchema },
  "runs:clearQueue": { input: z.undefined(), output: RunQueueStatusSchema },
  "evidence:list": { input: ExecutionRefSchema, output: z.array(EvidenceArtifactSchema) },
  "evidence:file": { input: EvidenceRefSchema, output: EvidenceFileSchema },
  "evidence:search": { input: EvidenceSearchInputSchema, output: EvidenceSearchResultSchema },
  "evidence:hierarchy": { input: EvidenceRefSchema, output: HierarchyViewSchema },
  "evidence:prepareUpload": { input: PrepareUploadInputSchema, output: UploadPreviewSchema },
  "evidence:upload": { input: UploadInputSchema, output: UploadRecordSchema },
  "evidence:uploads": { input: ExecutionRefSchema, output: z.array(UploadRecordSchema) },
  "remote:verify": { input: z.undefined(), output: RemoteVerifySchema },
  "remote:repos": { input: z.undefined(), output: z.array(RemoteRepoSchema) },
  "workspace:status": { input: z.undefined(), output: WorkspaceStatusSchema },
  "workspace:connect": { input: z.undefined(), output: WorkspaceStatusSchema },
  "workspace:sync": { input: z.undefined(), output: WorkspaceStatusSchema },
  "workspace:testcases": { input: z.undefined(), output: TestcaseListSchema },
  "workspace:accounts": { input: z.undefined(), output: WorkspaceAccountsSchema },
  "workspace:readTestcase": { input: TestcaseRefSchema, output: TestcaseTextSchema },
  "workspace:saveTestcase": { input: SaveTestcaseInputSchema, output: SaveTestcaseResultSchema },
  "workspace:requestReview": { input: RequestReviewInputSchema, output: RequestReviewResultSchema },
  "workspace:branches": { input: z.undefined(), output: WorkBranchListSchema },
  "workspace:checkout": { input: CheckoutInputSchema, output: WorkspaceStatusSchema },
  "workspace:readApp": { input: ReadAppSettingsInputSchema, output: AppSettingsDocSchema },
  "workspace:saveApp": { input: SaveAppSettingsInputSchema, output: SaveAppSettingsResultSchema },
  "workspace:history": { input: TestcaseRefSchema, output: TestcaseHistorySchema },
  "workspace:myPulls": { input: z.undefined(), output: z.array(MyPullRequestSchema) },
  "agent:usage": { input: z.undefined(), output: AgentUsageSchema },
  "agent:startAuthor": { input: StartAuthorInputSchema, output: AuthorJobSchema },
  "agent:authorStatus": { input: AgentJobRefSchema, output: AuthorJobSchema },
  "agent:currentAuthor": { input: z.undefined(), output: AuthorJobSchema.nullable() },
  "agent:cancel": { input: AgentJobRefSchema, output: AuthorJobSchema },
  "agent:judge": { input: ExecutionRefSchema, output: z.array(JudgementSchema) },
  "agent:judgements": { input: ExecutionRefSchema, output: z.array(JudgementSchema) },
  "agent:startClaudeJudge": { input: ExecutionRefSchema, output: ClaudeJudgeJobSchema },
  "agent:claudeJudgeStatus": { input: AgentJobRefSchema, output: ClaudeJudgeJobSchema },
  "agent:cancelClaudeJudge": { input: AgentJobRefSchema, output: ClaudeJudgeJobSchema },
  "claude:status": { input: z.undefined(), output: ClaudeConnectionSchema },
  "claude:connectDesktop": { input: z.undefined(), output: ClaudeConnectionSchema },
  "update:status": { input: z.undefined(), output: UpdateStatusSchema },
  "update:check": { input: z.undefined(), output: UpdateStatusSchema },
  "update:download": { input: z.undefined(), output: UpdateStatusSchema },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]["input"]>;
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]["output"]>;

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === "string" && Object.hasOwn(ipcContract, value);
}

/** main 쪽 핸들러 구현이 맞춰야 하는 타입. 입력은 이미 검증된 값이다. */
export type IpcHandlers = {
  [C in IpcChannel]: (
    input: z.output<IpcContract[C]["input"]>,
  ) => IpcOutput<C> | Promise<IpcOutput<C>>;
};

/** preload가 window.qa 로 노출하는 API. 채널을 기능별로 묶는다. */
export interface QaApi {
  app: {
    getInfo(): Promise<AppInfo>;
    ping(input: IpcInput<"app:ping">): Promise<IpcOutput<"app:ping">>;
    /** 허용 목록(https://github.com)의 주소만 기본 브라우저로 연다(CLAUDE.md 5장) */
    openExternal(input: { url: string }): Promise<{ opened: true }>;
  };
  settings: {
    get(): Promise<SettingsState>;
    update(patch: SettingsPatch): Promise<Settings>;
  };
  db: {
    status(): Promise<DbStatus>;
  };
  devices: {
    list(): Promise<DeviceList>;
    /** QA 시뮬레이터를 만들거나 찾아 부팅하고 언어·동작 줄이기를 맞춘다. */
    prepareIos(input: { deviceType?: string }): Promise<Device>;
    /** AVD 를 화면 없이 부팅하고 언어·애니메이션을 맞춘다. */
    prepareAndroid(input: { avd?: string }): Promise<Device>;
    shutdown(input: { platform: "ios" | "android"; id: string }): Promise<Device>;
  };
  builds: {
    list(): Promise<Build[]>;
    /** main 이 파일 선택 창을 열어 고른 .app/.apk 를 등록한다. 취소하면 null. */
    pickAndRegister(input: { app: string }): Promise<Build | null>;
    /** main 이 선택 창으로 빌드 스크립트를 골라 실행하고 결과물을 등록한다. 취소하면 null. */
    runScript(input: { app: string }): Promise<Build | null>;
    install(input: { buildId: string; deviceId: string }): Promise<InstallResult>;
  };
  runs: {
    /** main 이 선택 창으로 플로우 파일을 고른다. 고른 경로만 start 에 쓸 수 있다. 취소하면 null. */
    pickFlow(): Promise<PickedFlow | null>;
    /** 실행을 만들고 바로 돌려준다. 진행은 get·list 로 확인한다. */
    start(input: StartRunInput): Promise<RunSummary>;
    list(): Promise<RunSummary[]>;
    get(input: { runId: string }): Promise<RunDetail>;
    cancel(input: { runId: string }): Promise<RunSummary>;
    /** "보관" 표시: 보관 기간이 지나도 증적을 지우지 않는다 */
    setKeep(input: { runId: string; keep: boolean }): Promise<RunSummary>;
    /** 워크스페이스의 TC 하나 또는 태그(active TC 들)를 이 기기에서 차례로 실행한다 */
    startFromWorkspace(input: StartFromWorkspaceInput): Promise<RunQueueStatus>;
    queue(): Promise<RunQueueStatus>;
    clearQueue(): Promise<RunQueueStatus>;
  };
  /** 실행 증적(가린 사본)만 읽는다. 경로는 그 실행의 증적 폴더 안으로 제한된다. */
  evidence: {
    list(input: { runId: string; executionId: string }): Promise<EvidenceArtifact[]>;
    /** 캡처는 data URL, 텍스트는 내용(크면 끝부분) */
    file(input: { runId: string; executionId: string; path: string }): Promise<EvidenceFile>;
    /** 로그·콘솔·JUnit 에서 대소문자 구분 없이 찾는다 */
    search(input: { runId: string; executionId: string; query: string }): Promise<EvidenceSearchResult>;
    hierarchy(input: { runId: string; executionId: string; path: string }): Promise<HierarchyView>;
    /** 요약 묶음을 만들고 가림 게이트를 통과하는지 본다(올리지 않는다). 정책 스위치(D11)가 꺼져 있으면 거부 */
    prepareUpload(input: PrepareUploadInput): Promise<UploadPreview>;
    /** "개인정보 확인함" 뒤에 증적 저장소에 올린다 */
    upload(input: { bundleId: string; privacyConfirmed: true }): Promise<UploadRecord>;
    uploads(input: { runId: string; executionId: string }): Promise<UploadRecord[]>;
  };
  remote: {
    /** 저장된 GitHub 토큰으로 로그인과 워크스페이스·증적 저장소 권한을 확인한다 */
    verify(): Promise<RemoteVerify>;
    /** 저장된 GitHub 토큰으로 볼 수 있는 저장소. 워크스페이스·증적·앱 저장소를 목록에서 고른다 */
    repos(): Promise<RemoteRepo[]>;
  };
  /** 워크스페이스 저장소. main 에 직접 푸시하지 않고 작업 브랜치와 PR 로만 올린다(PLAN 4.4) */
  workspace: {
    status(): Promise<WorkspaceStatus>;
    connect(): Promise<WorkspaceStatus>;
    sync(): Promise<WorkspaceStatus>;
    testcases(): Promise<TestcaseList>;
    /** 앱마다 필요한 테스트 계정 값의 키 이름(accounts.yaml). 연결 전이면 connected: false */
    accounts(): Promise<WorkspaceAccounts>;
    readTestcase(input: { app: string; id: string }): Promise<{ path: string; text: string }>;
    /** 검증 → 이 TC 의 작업 브랜치(다른 TC 의 브랜치에는 섞지 않는다) → 커밋 */
    saveTestcase(input: { app: string; id: string; text: string; summary: string }): Promise<SaveTestcaseResult>;
    /** 작업 브랜치(없으면 지금 브랜치)를 푸시하고 PR 을 만든다. 열린 PR 이 있으면 그 PR 에 올린다 */
    requestReview(input: { title: string; body: string; branch?: string }): Promise<RequestReviewResult>;
    /** 내 작업 브랜치 목록 */
    branches(): Promise<WorkBranchList>;
    /** main 이나 내 작업 브랜치로 바꾼다. 저장하지 않은 변경이나 진행 중인 실행·플로우 만들기가 있으면 바꾸지 않는다 */
    checkout(input: { branch: string }): Promise<WorkspaceStatus>;
    /** 앱 설정(이름·언어·타깃별 앱 ID·계정 역할). 그 앱의 진행 중인 앱 설정 브랜치가 있으면 거기서 읽는다. 없는 앱이면 exists: false */
    readApp(input: { app: string }): Promise<AppSettingsDoc>;
    /** 검사 → 그 앱의 앱 설정 작업 브랜치 → 커밋(새 앱이면 workspace.yaml 앱 목록까지). TC·플로우가 쓰는 타깃·역할·키는 지우지 못한다 */
    saveApp(input: SaveAppSettingsInput): Promise<SaveAppSettingsResult>;
    /** TC 파일의 변경 내역(최근 20개) */
    history(input: { app: string; id: string }): Promise<TestcaseHistory>;
    /** 워크스페이스 저장소의 내 열린 PR */
    myPulls(): Promise<MyPullRequest[]>;
  };
  /** LLM 사용량·비용(PLAN 6.4). 키와 프롬프트 내용은 보내지 않는다 */
  agent: {
    usage(): Promise<AgentUsage>;
    /** TC 로 플로우 만들기를 시작한다(PLAN 6.5). 진행은 authorStatus 로 본다 */
    startAuthor(input: StartAuthorInput): Promise<AuthorJob>;
    authorStatus(input: { jobId: string }): Promise<AuthorJob>;
    /** 진행 중인 플로우 만들기, 없으면 이번 실행에서 마지막으로 시작한 것. 화면을 다시 열 때 이어 본다 */
    currentAuthor(): Promise<AuthorJob | null>;
    cancel(input: { jobId: string }): Promise<AuthorJob>;
    /** 실행의 화면 캡처를 지금 판정한다(LLM 호출, 비용 발생) */
    judge(input: { runId: string; executionId: string }): Promise<Judgement[]>;
    judgements(input: { runId: string; executionId: string }): Promise<Judgement[]>;
    /** Claude 앱 방식 화면 판정(ADR 0022). 작업을 만들고 Claude 에 붙여 넣을 요청을 돌려준다 */
    startClaudeJudge(input: { runId: string; executionId: string }): Promise<ClaudeJudgeJob>;
    claudeJudgeStatus(input: { jobId: string }): Promise<ClaudeJudgeJob>;
    cancelClaudeJudge(input: { jobId: string }): Promise<ClaudeJudgeJob>;
  };
  /** 각자의 Claude 앱 연결(MCP, ADR 0022) */
  claude: {
    status(): Promise<ClaudeConnection>;
    /** Claude 데스크톱 앱 설정에 Avocado 를 등록한다(다른 항목은 그대로, 사본을 남긴다) */
    connectDesktop(): Promise<ClaudeConnection>;
  };
  /** 새 버전 확인과 .dmg 받기(SHA-256·서명 확인 뒤에만 연다) */
  update: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
  };
  setup: {
    check(): Promise<SetupReport>;
    installTool(input: { tool: ToolId }): Promise<ToolStatus>;
    progress(): Promise<InstallProgress>;
    verifyMaestro(): Promise<MaestroVerify>;
    /** 필수 점검이 모두 통과해야 성공한다. */
    complete(): Promise<Settings>;
  };
  /** 비밀은 저장·삭제·상태 조회만 가능하다. 값을 읽는 함수는 없다. */
  secrets: {
    list(): Promise<SecretsList>;
    set(input: { name: SecretName; value: string }): Promise<SecretStatus>;
    delete(input: { name: SecretName }): Promise<SecretStatus>;
  };
}
