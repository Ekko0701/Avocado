import type { IpcChannel, IpcInput, IpcOutput, QaApi } from "@qa/shared";
import { contextBridge, ipcRenderer } from "electron";

// 샌드박스 preload: electron 의 contextBridge, ipcRenderer 만 쓴다.
// 계약의 채널만 함수로 노출하고, 임의 채널을 부르는 범용 invoke 는 노출하지 않는다.
function invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
  return ipcRenderer.invoke(channel, input) as Promise<IpcOutput<C>>;
}

const api: QaApi = {
  app: {
    getInfo: () => invoke("app:getInfo", undefined),
    ping: (input) => invoke("app:ping", input),
    openExternal: (input) => invoke("app:openExternal", input),
  },
  settings: {
    get: () => invoke("settings:get", undefined),
    update: (patch) => invoke("settings:update", patch),
  },
  db: {
    status: () => invoke("db:status", undefined),
  },
  devices: {
    list: () => invoke("devices:list", undefined),
    prepareIos: (input) => invoke("devices:prepareIos", input),
    prepareAndroid: (input) => invoke("devices:prepareAndroid", input),
    shutdown: (input) => invoke("devices:shutdown", input),
    iosOptions: () => invoke("devices:iosOptions", undefined),
    deleteIos: (input) => invoke("devices:deleteIos", input),
  },
  builds: {
    list: () => invoke("builds:list", undefined),
    pickAndRegister: (input) => invoke("builds:pickAndRegister", input),
    runScript: (input) => invoke("builds:runScript", input),
    install: (input) => invoke("builds:install", input),
  },
  runs: {
    pickFlow: () => invoke("runs:pickFlow", undefined),
    start: (input) => invoke("runs:start", input),
    list: () => invoke("runs:list", undefined),
    get: (input) => invoke("runs:get", input),
    cancel: (input) => invoke("runs:cancel", input),
    setKeep: (input) => invoke("runs:setKeep", input),
    startFromWorkspace: (input) => invoke("runs:startFromWorkspace", input),
    queue: () => invoke("runs:queue", undefined),
    clearQueue: () => invoke("runs:clearQueue", undefined),
  },
  evidence: {
    list: (input) => invoke("evidence:list", input),
    file: (input) => invoke("evidence:file", input),
    search: (input) => invoke("evidence:search", input),
    hierarchy: (input) => invoke("evidence:hierarchy", input),
    prepareUpload: (input) => invoke("evidence:prepareUpload", input),
    upload: (input) => invoke("evidence:upload", input),
    uploads: (input) => invoke("evidence:uploads", input),
  },
  remote: {
    verify: () => invoke("remote:verify", undefined),
    repos: () => invoke("remote:repos", undefined),
  },
  workspace: {
    status: () => invoke("workspace:status", undefined),
    myPulls: () => invoke("workspace:myPulls", undefined),
    connect: () => invoke("workspace:connect", undefined),
    sync: () => invoke("workspace:sync", undefined),
    testcases: () => invoke("workspace:testcases", undefined),
    accounts: () => invoke("workspace:accounts", undefined),
    readTestcase: (input) => invoke("workspace:readTestcase", input),
    saveTestcase: (input) => invoke("workspace:saveTestcase", input),
    requestReview: (input) => invoke("workspace:requestReview", input),
    branches: () => invoke("workspace:branches", undefined),
    checkout: (input) => invoke("workspace:checkout", input),
    readApp: (input) => invoke("workspace:readApp", input),
    saveApp: (input) => invoke("workspace:saveApp", input),
    history: (input) => invoke("workspace:history", input),
  },
  agent: {
    usage: () => invoke("agent:usage", undefined),
    startAuthor: (input) => invoke("agent:startAuthor", input),
    authorStatus: (input) => invoke("agent:authorStatus", input),
    currentAuthor: () => invoke("agent:currentAuthor", undefined),
    cancel: (input) => invoke("agent:cancel", input),
    judge: (input) => invoke("agent:judge", input),
    judgements: (input) => invoke("agent:judgements", input),
    startClaudeJudge: (input) => invoke("agent:startClaudeJudge", input),
    claudeJudgeStatus: (input) => invoke("agent:claudeJudgeStatus", input),
    cancelClaudeJudge: (input) => invoke("agent:cancelClaudeJudge", input),
  },
  claude: {
    status: () => invoke("claude:status", undefined),
    connectDesktop: () => invoke("claude:connectDesktop", undefined),
  },
  update: {
    status: () => invoke("update:status", undefined),
    check: () => invoke("update:check", undefined),
    download: () => invoke("update:download", undefined),
  },
  setup: {
    check: () => invoke("setup:check", undefined),
    installTool: (input) => invoke("setup:installTool", input),
    progress: () => invoke("setup:progress", undefined),
    verifyMaestro: () => invoke("setup:verifyMaestro", undefined),
    complete: () => invoke("setup:complete", undefined),
  },
  secrets: {
    list: () => invoke("secrets:list", undefined),
    set: (input) => invoke("secrets:set", input),
    delete: (input) => invoke("secrets:delete", input),
  },
};

contextBridge.exposeInMainWorld("qa", api);
