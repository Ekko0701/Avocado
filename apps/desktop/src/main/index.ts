import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppDatabase } from "./db/database";
import { createHandlers } from "./handlers";
import { registerIpcHandlers } from "./ipc";
import { hardenSession, hardenWebContents, isAllowedAppUrl, secureWebPreferences } from "./security";
import { safeStorageCrypto } from "./settings/safe-storage-crypto";
import { SettingsService, type SecretCrypto } from "./settings/settings-service";
import { createTestOnlyCrypto } from "./settings/test-only-crypto";
import { runCommand } from "./setup/command";
import { ToolInstaller } from "./setup/installer";
import { SetupService } from "./setup/setup-service";
import { loadToolOverrides } from "./setup/tools";
import { DeviceService } from "./devices/device-service";
import { spawnDetached } from "./devices/spawn";
import { BuildService } from "./builds/build-service";
import { RunService } from "./runs/run-service";
import { RunQueue } from "./runs/run-queue";
import { EvidenceService } from "./evidence/evidence-service";
import { AskpassServer, GitHubProvider } from "@qa/remote";
import { WorkspaceService } from "./workspace/workspace-service";
import { AgentJobStore } from "./agent/agent-job-store";
import { AuthorService } from "./agent/author-service";
import { ClaudeConnectService } from "./claude/claude-connect";
import { createAvocadoMcpServer, routeMcpPorts } from "./claude/mcp-server";
import { McpSocketHost } from "./claude/socket-host";
import { JudgeService } from "./agent/judge-service";
import { UpdateService } from "./update/update-service";
import { UPDATE_SIGNER_TEAM_ID } from "./update/trust";
import { UploadService } from "./evidence/upload-service";
import { EvidenceRetention } from "./evidence/retention";
import { createSipsJpegConverter, createSipsShrinker } from "./agent/image";
import { cleanupDrivers } from "./runs/drivers";
import { maestroEnv } from "./setup/setup-service";
import Anthropic from "@anthropic-ai/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync } from "node:fs";

const devServerUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
const rendererIndex = join(__dirname, "../renderer/index.html");
const isAllowed = (url: string): boolean =>
  isAllowedAppUrl(url, { devServerUrl, rendererIndexUrl: pathToFileURL(rendererIndex).href });

// 자동 E2E 는 패키징되지 않은 앱에서만 데이터 폴더를 임시 폴더로 바꾸고, 실제 키체인 대신 테스트 암호화를 쓸 수 있다.
const testUserData = app.isPackaged ? undefined : process.env["QA_USER_DATA_DIR"];
if (testUserData) app.setPath("userData", testUserData);
const useTestCrypto = !app.isPackaged && process.env["QA_E2E_TEST_CRYPTO"] === "1";
// 자동 E2E 가 로컬 서버의 가짜 도구로 설치 흐름을 시험할 때만 쓴다(패키징된 앱은 무시).
const testToolsFile = app.isPackaged ? undefined : process.env["QA_E2E_TOOLS_FILE"];
// 자동 E2E 가 가짜 GitHub API 서버를 쓸 때만(패키징된 앱은 무시).
const testGitHubApi = app.isPackaged ? undefined : process.env["QA_E2E_GITHUB_API"];
const testGitHubWeb = app.isPackaged ? undefined : process.env["QA_E2E_GITHUB_WEB"];

function secretCrypto(): SecretCrypto {
  if (!useTestCrypto) return safeStorageCrypto;
  console.warn("[qa] QA_E2E_TEST_CRYPTO=1: 테스트 전용 암호화를 쓴다. 실제 사용 금지.");
  return createTestOnlyCrypto();
}

// 모든 렌더러를 샌드박스로 강제한다. ready 전에 호출해야 한다.
app.enableSandbox();

app.on("web-contents-created", (_event, contents) => {
  hardenWebContents(contents, isAllowed);
});

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Avocado",
    show: false,
    webPreferences: secureWebPreferences(join(__dirname, "../preload/index.js")),
  });
  win.once("ready-to-show", () => win.show());
  if (devServerUrl) {
    // 개발 모드에서는 렌더러 콘솔(CSP 위반 포함)을 터미널로 넘겨 바로 보이게 한다.
    win.webContents.on("console-message", (details) => {
      console.log(`[renderer:${details.level}] ${details.message}`);
    });
    win.webContents.on("did-finish-load", () => {
      console.log("[renderer] did-finish-load");
    });
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(rendererIndex);
  }
  return win;
}

void app.whenReady().then(() => {
  hardenSession(session.defaultSession, devServerUrl);
  const settings = new SettingsService({ dir: app.getPath("userData"), crypto: secretCrypto() });
  settings.init();
  let db: AppDatabase;
  try {
    db = AppDatabase.open(join(app.getPath("userData"), "db.sqlite"));
  } catch (error) {
    // 조용히 새 DB 로 대체하지 않는다. 원인을 보여 주고 종료한다.
    dialog.showErrorBox("로컬 DB를 열 수 없습니다", error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }
  app.on("will-quit", () => db.close());
  const installer = new ToolInstaller({
    toolsDir: join(app.getPath("userData"), "tools"),
    tools: loadToolOverrides(testToolsFile),
    run: runCommand,
  });
  const setup = new SetupService({
    installer,
    run: runCommand,
    env: { HOME: app.getPath("home"), ANDROID_HOME: process.env["ANDROID_HOME"] },
  });
  const devices = new DeviceService({
    run: runCommand,
    spawnDetached,
    androidHome: process.env["ANDROID_HOME"] || join(app.getPath("home"), "Library", "Android", "sdk"),
    locale: () => settings.getSettings().settings.devices.locale,
    logDir: join(app.getPath("userData"), "logs"),
  });
  const builds = new BuildService({
    db,
    run: runCommand,
    devices,
    buildsDir: join(app.getPath("userData"), "builds"),
    logDir: join(app.getPath("userData"), "logs"),
    androidHome: process.env["ANDROID_HOME"] || join(app.getPath("home"), "Library", "Android", "sdk"),
    home: app.getPath("home"),
  });
  const pick = async (options: Electron.OpenDialogOptions): Promise<string | null> => {
    const window = BrowserWindow.getFocusedWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
  const buildPickers = {
    pickArtifact: () =>
      pick({
        title: "시뮬레이터용 .app 또는 .apk 선택",
        // .app 은 패키지라 파일처럼 고를 수 있다. treatPackageAsDirectory 를 켜면 고르지 못하고 안으로 들어간다.
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "앱 빌드", extensions: ["app", "apk"] }],
      }),
    pickScript: () => pick({ title: "빌드 스크립트 선택", properties: ["openFile"] }),
  };
  const accountSecrets = (appName: string): Record<string, string> => {
    const prefix = `account:${appName}:`;
    const out: Record<string, string> = {};
    for (const item of settings.listSecrets().items) {
      if (!item.stored || !item.name.startsWith(prefix)) continue;
      const value = settings.getSecret(item.name);
      if (value !== null) out[item.name.slice(prefix.length)] = value;
    }
    return out;
  };
  // 실행이 끝난 뒤의 후처리(화면 판정). RunService 보다 뒤에 만들어지므로 나중에 이어 붙인다
  let onRunFinished: (runId: string) => void = () => undefined;
  const runs = new RunService({
    onFinished: (runId) => onRunFinished(runId),
    db,
    devices,
    builds,
    tools: installer,
    accountSecrets,
    redactionSecrets: () =>
      settings
        .listSecrets()
        .items.filter((i) => i.stored)
        .map((i) => settings.getSecret(i.name))
        .filter((v): v is string => v !== null),
    evidenceRoot: join(app.getPath("userData"), "evidence"),
    trustedFlowRoots: [join(app.getPath("userData"), "workspaces")],
    home: app.getPath("home"),
    androidHome: process.env["ANDROID_HOME"] || join(app.getPath("home"), "Library", "Android", "sdk"),
    run: runCommand,
  });
  const runPickers = {
    pickFlow: () => pick({ title: "실행할 Maestro 플로우 선택", properties: ["openFile"], filters: [{ name: "Maestro 플로우", extensions: ["yaml", "yml"] }] }),
  };
  const evidence = new EvidenceService({ db, evidenceRoot: join(app.getPath("userData"), "evidence") });
  // 로컬 증적 보관(PLAN 9.1). 자동 E2E 의 테스트 데이터 폴더에서는 돌리지 않는다
  const retention = new EvidenceRetention({
    db,
    evidenceRoot: join(app.getPath("userData"), "evidence"),
    retentionDays: () => settings.getSettings().settings.evidence.retentionDays,
    log: (entry) => {
      mkdirSync(join(app.getPath("userData"), "logs"), { recursive: true });
      appendFileSync(join(app.getPath("userData"), "logs", "evidence.log"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    },
  });
  if (!testUserData) retention.schedule();
  const agentJobs = new AgentJobStore(db);
  agentJobs.recoverInterrupted();
  // GitHub 요청 기록: JSON 한 줄씩, 메서드·경로·상태·시간만(토큰·헤더·본문 없음, CLAUDE.md 4·6장)
  const logDir = join(app.getPath("userData"), "logs");
  const remote = new GitHubProvider({
    token: () => settings.getSecret("githubToken"),
    apiUrl: testGitHubApi,
    webUrl: testGitHubWeb,
    userAgent: `avocado/${app.getVersion()}`,
    log: (entry) => {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "remote.log"), `${JSON.stringify({ at: new Date().toISOString(), service: "remote", ...entry })}\n`, { mode: 0o600 });
    },
  });
  // git 인증 도우미는 처음 쓸 때 띄우고 앱이 끝날 때 닫는다(ADR 0013)
  let askpass: Promise<AskpassServer> | null = null;
  const getAskpass = () => (askpass ??= AskpassServer.start());
  app.on("will-quit", () => {
    void askpass?.then((s) => s.close());
  });
  // 플로우 만들기는 WorkspaceService 보다 뒤에 만들어지므로 나중에 이어 붙인다
  let authorBusy: () => string | null = () => null;
  const workspace = new WorkspaceService({
    root: join(app.getPath("userData"), "workspaces"),
    remote,
    github: () => settings.getSettings().settings.github,
    token: () => settings.getSecret("githubToken"),
    askpass: getAskpass,
    // 실행·플로우 만들기가 워크스페이스 파일을 쓰는 동안에는 작업 브랜치를 바꾸지 않는다
    busy: (except) => (except !== "author" ? authorBusy() : null) ?? (runs.activeCount() > 0 ? "플로우 실행이 진행 중이다" : null),
  });
  const androidHome = process.env["ANDROID_HOME"] || join(app.getPath("home"), "Library", "Android", "sdk");
  const author = new AuthorService({
    jobs: agentJobs,
    workspace,
    runs,
    devices,
    builds,
    provider: () => settings.getSettings().settings.agent.provider,
    monthlyBudgetUsd: () => settings.getSettings().settings.agent.monthlyBudgetUsd,
    apiKey: () => settings.getSecret("anthropicApiKey"),
    accountSecrets,
    defaultLocale: () => settings.getSettings().settings.devices.locale,
    // 주소를 명시한다. ANTHROPIC_BASE_URL 같은 셸 환경 변수로 키와 화면 데이터가 다른 곳으로 가지 않게 한다
    createClient: (apiKey) => new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 2 }),
    // maestro mcp 는 stdio 로만 띄운다(CLAUDE.md 9장). 앱이 관리하는 Maestro·JRE 만 쓰고, 먼저 이 기기의 잔여 드라이버를 정리한다
    connectMaestro: async (device) => {
      const bin = installer.maestroBin();
      const javaHome = installer.javaHome();
      if (!bin || !javaHome) throw new Error("Maestro·JRE 가 설치되지 않았다. 설정 마법사에서 설치한다");
      await cleanupDrivers({ run: runCommand, device, androidHome, kill: (pid, signal) => process.kill(pid, signal) });
      const env = { ...maestroEnv(javaHome, app.getPath("home")), MAESTRO_DRIVER_STARTUP_TIMEOUT: "90000" };
      // --no-viewer: maestro mcp 가 기본으로 여는 로컬 HTTP 뷰어를 끈다(stdio 만, CLAUDE.md 9장). 파일 기준 폴더는 빈 폴더로 둔다
      const workDir = join(app.getPath("userData"), "agent", "mcp-work");
      mkdirSync(workDir, { recursive: true, mode: 0o700 });
      return new StdioClientTransport({
        command: bin,
        args: ["mcp", "--no-viewer", `--working-dir=${workDir}`],
        env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
        cwd: workDir,
        stderr: "pipe",
      });
    },
    shrinkImage: createSipsShrinker(runCommand, join(app.getPath("userData"), "tmp")),
    auditDir: join(app.getPath("userData"), "agent"),
  });
  const allSecrets = () =>
    settings
      .listSecrets()
      .items.filter((i) => i.stored)
      .map((i) => settings.getSecret(i.name))
      .filter((v): v is string => v !== null);
  const judge = new JudgeService({
    db,
    jobs: agentJobs,
    runs,
    evidence,
    provider: () => settings.getSettings().settings.agent.provider,
    apiKey: () => settings.getSecret("anthropicApiKey"),
    monthlyBudgetUsd: () => settings.getSettings().settings.agent.monthlyBudgetUsd,
    sampleRate: () => settings.getSettings().settings.agent.judgeSampleRate,
    createClient: (apiKey) => new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 2 }),
    shrinkImage: createSipsShrinker(runCommand, join(app.getPath("userData"), "tmp")),
    secrets: allSecrets,
    auditDir: join(app.getPath("userData"), "agent"),
    log: (entry) => {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "agent.log"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    },
  });
  onRunFinished = (runId) => void judge.autoJudge(runId);
  authorBusy = () => author.busy();
  // 각자의 Claude 앱 연결(D17, ADR 0022): Claude 앱이 nc 로 이 소켓에 붙어 author 도구를 부른다
  const mcpPort = routeMcpPorts([
    { tools: () => AuthorService.mcpTools(), call: (connection, name, args, signal) => author.mcpCall(connection, name, args, signal) },
    { tools: () => JudgeService.mcpTools(), call: (connection, name, args) => judge.mcpCall(connection, name, args) },
  ]);
  const mcpHost = new McpSocketHost({
    socketPath: join(app.getPath("userData"), "mcp", "avocado.sock"),
    createServer: (connectionId, onInitialized) =>
      createAvocadoMcpServer({
        port: mcpPort,
        version: app.getVersion(),
        connectionId,
        onInitialized,
      }),
    onDisconnect: (connectionId) => {
      author.releaseConnection(connectionId);
      judge.releaseConnection(connectionId);
    },
    log: (entry) => {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "claude.log"), `${JSON.stringify({ at: new Date().toISOString(), service: "claude", ...entry })}\n`, { mode: 0o600 });
    },
  });
  void mcpHost.start();
  app.on("will-quit", () => void mcpHost.close());
  const claude = new ClaudeConnectService({ host: mcpHost, home: app.getPath("home") });
  const upload = new UploadService({
    db,
    runs,
    evidence,
    remote,
    uploadApproved: () => settings.getSettings().settings.policy.evidenceUploadApproved,
    github: () => settings.getSettings().settings.github,
    // 키체인의 값 + 홈 폴더 경로(로그에 사용자 이름이 남는다, fixtures/README.md)
    secrets: () => [...allSecrets(), app.getPath("home")],
    toJpeg: createSipsJpegConverter(runCommand, join(app.getPath("userData"), "tmp")),
    generator: `Avocado ${app.getVersion()}`,
  });
  const update = new UpdateService({
    remote,
    github: () => settings.getSettings().settings.github,
    currentVersion: app.getVersion(),
    arch: process.arch,
    updatesDir: join(app.getPath("userData"), "updates"),
    run: runCommand,
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    signerTeamId: UPDATE_SIGNER_TEAM_ID,
  });
  // 자동 E2E(패키징 안 된 앱의 테스트 데이터 폴더)에서는 주기 확인을 하지 않는다
  if (!testUserData) update.schedule();
  registerIpcHandlers(
    ipcMain,
    createHandlers({ settings, db, setup, devices, builds, buildPickers, runs, runPickers, runQueue: new RunQueue(runs), evidence, upload, remote, workspace, agentJobs, author, judge, claude, update }),
    isAllowed,
  );
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
