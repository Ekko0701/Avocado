import type { ArchiveProblem, TransferAction, TransferItem, TransferItemKind, TransferItemStatus } from "@qa/shared";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import { lintFlow, lintSubflow, subflowRefs } from "../flow-lint";
import { layout } from "../layout";
import { lintTestcase, type LintIssue } from "../lint";
import { AccountsSchema, AppConfigSchema, FlowMetaSchema, WorkspaceConfigSchema, type Accounts, type AppConfig, type Target } from "../schemas";
import { nextTestcaseId } from "../template";
import { foldPath, problem } from "./archive";
import { addAppToWorkspaceYaml, mergeAccountsYaml, mergeAppYaml, renumberFlowText, renumberMetaText, renumberTestcaseText } from "./yaml-edit";

/**
 * 가져오기 견주기(ADR 0036 결정 11). 받은 파일 묶음과 받는 쪽 워크스페이스(HEAD 또는 main 의 파일)를 견주어 항목마다 상태와 할 일을 정하고,
 * 고른 항목에서 쓸 파일(경로 → 바이트)을 만든다. 파일·git·창은 다루지 않는다(그것은 WorkspaceService 가 한다).
 * 받는 검사(린트·문법·스키마)는 "가져온 뒤의 받는 쪽"을 기준으로 한다. 받은 플로우는 시뮬레이터·Android 에서 이 검사 말고는 검사가 없다.
 */
export type FileTree = ReadonlyMap<string, Uint8Array>;

export interface ImportChecks {
  /** Maestro check-syntax. 오류면 이유를 담아 던진다 */
  checkFlowSyntax: (text: string) => Promise<void>;
}

export interface ImportWrites {
  /** 쓸 파일(워크스페이스 기준 경로 → 미리보기에서 만든 바이트) */
  files: Map<string, Uint8Array>;
  renumbered: { from: string; to: string }[];
  /** 고른 항목과 함께 들어가는 항목까지 */
  picked: { item: TransferItem; action: TransferAction }[];
}

export interface ImportPlan {
  items: TransferItem[];
  skipped: { path: string; reason: string }[];
  summary: Record<TransferItemStatus, number>;
  /** 고른 할 일로 쓸 파일을 만든다. 고를 수 없는 것을 고르면 ImportPickError */
  apply(picks: readonly { key: string; action: TransferAction }[]): ImportWrites;
}

export type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; problems: ArchiveProblem[] };

export class ImportPickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportPickError";
  }
}

/** 받는 쪽과 견준 결과. 항목 종류마다 나올 수 있는 값이 다르다 */
interface Comparison {
  /** taken: 같은 번호가 받는 쪽(다른 앱 포함)이나 이번 가져오기에 이미 있다 */
  testcase: "absent" | "taken" | "different" | "equal";
  /** adds: 더하기만 하면 된다, conflict: 같은 타깃의 앱 ID 가 다르다 */
  app: "absent" | "adds" | "conflict" | "equal";
  subflow: "absent" | "different" | "equal";
}

interface Row {
  status: TransferItemStatus;
  choices: TransferAction[];
  defaultChoice: TransferAction | null;
}

/** 상태와 할 일은 이 표 하나로 정한다(항목 종류 × 견준 결과). 검사에 걸린 항목은 REJECTED 다 */
const STATUS_TABLE: { [K in TransferItemKind]: Record<Comparison[K], Row> } = {
  testcase: {
    absent: { status: "new", choices: ["include"], defaultChoice: "include" },
    taken: { status: "renumber", choices: ["renumber"], defaultChoice: "renumber" },
    different: { status: "differs", choices: ["overwrite", "renumber"], defaultChoice: null },
    equal: { status: "same", choices: [], defaultChoice: null },
  },
  app: {
    absent: { status: "new", choices: ["include"], defaultChoice: "include" },
    adds: { status: "differs", choices: ["include"], defaultChoice: "include" },
    conflict: { status: "differs", choices: ["keep-ours", "take-theirs"], defaultChoice: "keep-ours" },
    equal: { status: "same", choices: [], defaultChoice: null },
  },
  subflow: {
    absent: { status: "new", choices: ["include"], defaultChoice: "include" },
    different: { status: "differs", choices: ["keep-ours", "take-theirs"], defaultChoice: "keep-ours" },
    equal: { status: "same", choices: [], defaultChoice: null },
  },
};
const REJECTED: Row = { status: "rejected", choices: [], defaultChoice: null };
const STATUSES: TransferItemStatus[] = ["new", "renumber", "differs", "same", "rejected"];

const TARGET_LABEL: Record<Target, string> = { ios: "iOS", android: "Android", "flutter-ios": "Flutter iOS", "flutter-android": "Flutter Android" };
const APP_FILE = /^apps\/([a-z0-9][a-z0-9-]{0,39})\/(app|accounts)\.yaml$/;
const YML_FLOW = /^apps\/[a-z0-9][a-z0-9-]{0,39}\/flows\/[^/]+\/TC-\d{4,}(\.meta)?\.yml$/;
const FLOW_TARGET = /^apps\/[a-z0-9][a-z0-9-]{0,39}\/flows\/([^/]+)\//;
/** 가져오는 서브플로우 이름: 소문자·숫자·-·_ 와 .yaml. 대소문자를 가리지 않는 디스크에서 기존 파일과 겹치지 않게 한다 */
const SUBFLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.yaml$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SYNTAX_CONCURRENCY = 3;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const decode = (bytes: Uint8Array | undefined): string | null => {
  if (!bytes) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};
/** 경로는 글자 코드 순서로 늘어놓는다(대소문자를 섞지 않는다) */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** YAML 을 읽어 스키마로 검사한다. 실패하면 줄 번호가 있는 이유 */
function parseFile<T>(file: string, text: string | null, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; reason: string } {
  if (text === null) return { ok: false, reason: `${file}: UTF-8 글자가 아닙니다` };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    return { ok: false, reason: `${file} YAML 오류: ${line ? `${line}줄 ` : ""}${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}` };
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, reason: `${file} 형식 오류: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(전체)"}: ${i.message}`).join(" / ")}` };
  return { ok: true, value: parsed.data };
}

const lintReasons = (what: string, issues: readonly LintIssue[]) => issues.filter((i) => i.level === "error").map((i) => `${what} 검사 오류: ${i.line ? `${i.line}줄 ` : ""}${i.message}`);
const roleKeys = (accounts: Accounts, role: string | undefined): string[] => (role ? [...(accounts[role]?.keys ?? [])] : []);
const allKeys = (accounts: Accounts): string[] => [...new Set(Object.values(accounts).flatMap((r) => r.keys))];
const envRefs = (text: string): string[] => [...text.matchAll(ENV_REF)].map((m) => m[1] ?? "");

function limiter(size: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            queue.shift()?.();
          });
      };
      if (active < size) run();
      else queue.push(run);
    });
}

/** 받는 쪽 워크스페이스를 읽은 것. 받는 쪽은 이 앱이 만든 저장소라 형식이 틀리면 견주지 않고 멈춘다 */
interface Receiving {
  tree: FileTree;
  /** 접은 경로 → 실제 경로 */
  fold: Map<string, string>;
  workspaceText: string;
  apps: Set<string>;
  app(app: string): { config: AppConfig; accounts: Accounts; appText: string; accountsText: string | null } | { problem: string } | null;
  ids: Set<string>;
  titles: Map<string, string>;
  common(app: string, target: string): Set<string>;
  path(path: string): string | undefined;
}

function readReceiving(tree: FileTree): Receiving {
  const lay = layout(2);
  const fold = new Map<string, string>();
  for (const path of tree.keys()) fold.set(foldPath(path), path);
  const workspaceText = decode(tree.get("workspace.yaml"));
  const ws = parseFile("workspace.yaml", workspaceText, WorkspaceConfigSchema);
  if (!ws.ok || workspaceText === null) throw new Error(`이 워크스페이스의 ${ws.ok ? "workspace.yaml 을 읽지 못했다" : ws.reason}`);
  if (ws.value.schemaVersion !== 2) throw new Error("이 워크스페이스는 예전 폴더 구조(schemaVersion 1)다. 워크스페이스 화면에서 폴더 구조를 먼저 바꾼다");
  const ids = new Set<string>();
  const titles = new Map<string, string>();
  const common = new Map<string, Set<string>>();
  for (const [path, bytes] of tree) {
    const info = lay.parse(path);
    if (info?.kind === "testcase" || info?.kind === "flow") ids.add(info.id);
    if (info?.kind === "testcase" && !titles.has(info.id)) {
      const title = /^title:\s*(.+)$/m.exec(decode(bytes) ?? "")?.[1]?.trim();
      if (title) titles.set(info.id, title.replace(/^["']|["']$/g, ""));
    }
    if (info?.kind === "subflow") {
      const set = common.get(`${info.app}/${info.target}`) ?? new Set<string>();
      set.add(info.name);
      common.set(`${info.app}/${info.target}`, set);
    }
  }
  return {
    tree,
    fold,
    workspaceText,
    apps: new Set(ws.value.apps),
    app(app) {
      if (!ws.value.apps.includes(app)) return null;
      const appText = decode(tree.get(`apps/${app}/app.yaml`));
      const config = parseFile(`apps/${app}/app.yaml`, appText, AppConfigSchema);
      if (!config.ok || appText === null) return { problem: config.ok ? "app.yaml 이 없다" : config.reason };
      const accountsBytes = tree.get(`apps/${app}/accounts.yaml`);
      const accountsText = accountsBytes ? decode(accountsBytes) : null;
      const accounts = accountsBytes ? parseFile(`apps/${app}/accounts.yaml`, accountsText, AccountsSchema) : { ok: true as const, value: {} };
      if (!accounts.ok) return { problem: accounts.reason };
      return { config: config.value, accounts: accounts.value, appText, accountsText };
    },
    ids,
    titles,
    common: (app, target) => common.get(`${app}/${target}`) ?? new Set(),
    path: (path) => fold.get(foldPath(path)),
  };
}

/** 미리보기 항목을 만드는 동안의 상태 */
interface Draft {
  key: string;
  kind: TransferItemKind;
  app: string;
  label: string;
  detail: string;
  /** 견준 결과로 정한 상태 표의 줄. 견주기 전에 걸렸으면 null */
  row: Row | null;
  reasons: string[];
  note: string;
  /** 바로 부르는 항목(앱 설정, 받는 쪽에 없는 서브플로우) */
  direct: Set<string>;
  renumberTo: string | null;
  renumberFrom: string | null;
  compare: { path: string; ours: string; theirs: string }[];
  /** 할 일마다 쓸 파일 */
  writes: Partial<Record<TransferAction, Map<string, Uint8Array>>>;
  /** 받는 쪽에 없는 앱이라 workspace.yaml 앱 목록에 더한다 */
  addsApp: boolean;
}

function draft(key: string, kind: TransferItemKind, app: string, label: string, detail: string): Draft {
  return { key, kind, app, label, detail, row: null, reasons: [], note: "", direct: new Set(), renumberTo: null, renumberFrom: null, compare: [], writes: {}, addsApp: false };
}

const compared = <K extends TransferItemKind>(kind: K, comparison: Comparison[K]): Row => STATUS_TABLE[kind][comparison];

const appKey = (app: string) => `app:${app}`;
const subflowKey = (app: string, target: string, name: string) => `subflow:${app}:${target}:${name}`;
const testcaseKey = (app: string, id: string) => `testcase:${app}:${id}`;

/** 받은 테스트 케이스 하나의 파일: .md 와 타깃별 플로우·meta */
interface TestcaseFiles {
  app: string;
  id: string;
  md?: Uint8Array;
  flows: Map<Target, Uint8Array>;
  metas: Map<Target, Uint8Array>;
}

/** 받은 앱 설정과 받는 쪽 앱 설정을 합친 모습(가져온 뒤의 받는 쪽) */
interface AppView {
  /** 받는 쪽 것 */
  targets: Set<string>;
  accounts: Accounts;
  /** 받은 것까지 합친 것 */
  mergedTargets: Set<string>;
  mergedAccounts: Accounts;
  /** 받은 묶음에 앱 설정 항목이 있으면 그 키 */
  itemKey: string | null;
  name: string;
}

function mergeAccounts(ours: Accounts, theirs: Accounts): Accounts {
  const out: Accounts = Object.fromEntries(Object.entries(ours).map(([role, r]) => [role, { description: r.description, keys: [...r.keys] }]));
  for (const [role, r] of Object.entries(theirs)) {
    const have = out[role];
    if (!have) out[role] = { description: r.description, keys: [...r.keys] };
    else have.keys = [...new Set([...have.keys, ...r.keys])];
  }
  return out;
}

export async function planImport(input: { incoming: FileTree; receiving: FileTree; checks: ImportChecks }): Promise<PlanResult> {
  const { incoming, checks } = input;
  const lay = layout(2);

  // 받은 묶음의 구조: workspace.yaml 의 schemaVersion 이 2 여야 한다
  const wsText = decode(incoming.get("workspace.yaml"));
  if (!incoming.has("workspace.yaml")) return { ok: false, problems: [problem("workspace.yaml", "layout", "workspace.yaml 이 없습니다. Avocado 워크스페이스를 내보낸 zip 이나 폴더가 아닙니다")] };
  let schemaVersion: unknown;
  try {
    const raw: unknown = wsText === null ? null : parseYaml(wsText);
    schemaVersion = raw !== null && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  } catch {
    schemaVersion = undefined;
  }
  if (schemaVersion === 1) return { ok: false, problems: [problem("workspace.yaml", "layout", "예전 폴더 구조(schemaVersion 1)의 워크스페이스입니다. 보낸 사람이 워크스페이스 화면에서 폴더 구조를 바꾼 뒤 다시 내보내야 합니다")] };
  if (schemaVersion !== 2) return { ok: false, problems: [problem("workspace.yaml", "layout", "workspace.yaml 의 schemaVersion 을 읽지 못했습니다")] };

  const recv = readReceiving(input.receiving);

  // 파일을 항목 모양으로 나눈다. 모양이 맞지 않는 파일은 이유와 함께 건너뛴다
  const skipped: { path: string; reason: string }[] = [];
  const appFiles = new Map<string, { app?: Uint8Array; accounts?: Uint8Array }>();
  const tcFiles = new Map<string, TestcaseFiles>();
  const subflowFiles: { app: string; target: Target; name: string; path: string; bytes: Uint8Array }[] = [];
  const tcGroup = (app: string, id: string): TestcaseFiles => {
    const k = `${app}/${id}`;
    const group: TestcaseFiles = tcFiles.get(k) ?? { app, id, flows: new Map(), metas: new Map() };
    tcFiles.set(k, group);
    return group;
  };
  for (const [path, bytes] of [...incoming].sort(([a], [b]) => byPath(a, b))) {
    if (path === "workspace.yaml") continue;
    const appFile = APP_FILE.exec(path);
    if (appFile) {
      const entry = appFiles.get(appFile[1] ?? "") ?? {};
      entry[appFile[2] === "app" ? "app" : "accounts"] = bytes;
      appFiles.set(appFile[1] ?? "", entry);
      continue;
    }
    const info = lay.parse(path);
    if (info?.kind === "testcase") tcGroup(info.app, info.id).md = bytes;
    else if (info?.kind === "flow") tcGroup(info.app, info.id)[info.meta ? "metas" : "flows"].set(info.target, bytes);
    else if (info?.kind === "subflow") subflowFiles.push({ app: info.app, target: info.target, name: info.name, path, bytes });
    else if (YML_FLOW.test(path)) skipped.push({ path, reason: "플로우 파일 이름은 .yaml 로 끝나야 합니다" });
    else if (FLOW_TARGET.test(path) && !lay.parse(path)) skipped.push({ path, reason: `타깃 폴더(${FLOW_TARGET.exec(path)?.[1] ?? ""})는 ios, android, flutter-ios, flutter-android 중 하나여야 합니다` });
    else if (/^(testcases|flows)\//.test(path)) skipped.push({ path, reason: "예전 폴더 구조(schemaVersion 1)의 위치입니다" });
    else skipped.push({ path, reason: "워크스페이스 파일이 아닙니다" });
  }
  for (const group of tcFiles.values()) {
    if (group.md) {
      for (const target of [...group.metas.keys()]) {
        if (group.flows.has(target)) continue;
        skipped.push({ path: lay.metaPath(group.app, target, group.id), reason: "플로우 파일이 없는 플로우 정보(meta)입니다" });
        group.metas.delete(target);
      }
      continue;
    }
    for (const target of group.flows.keys()) skipped.push({ path: lay.flowPath(group.app, target, group.id), reason: "테스트 케이스 파일이 없는 플로우입니다" });
    for (const target of group.metas.keys()) skipped.push({ path: lay.metaPath(group.app, target, group.id), reason: "테스트 케이스 파일이 없는 플로우 정보(meta)입니다" });
    tcFiles.delete(`${group.app}/${group.id}`);
  }
  skipped.sort((a, b) => byPath(a.path, b.path));

  const drafts = new Map<string, Draft>();
  const views = new Map<string, AppView>();

  // 앱 설정
  const incomingApps = new Set([...appFiles.keys(), ...[...tcFiles.values()].map((g) => g.app), ...subflowFiles.map((s) => s.app)]);
  for (const app of [...incomingApps].sort()) {
    const files = appFiles.get(app);
    const ours = recv.app(app);
    const oursValid = ours !== null && "config" in ours ? ours : null;
    const appText = files?.app ? decode(files.app) : null;
    const theirsConfig = files?.app ? parseFile(`apps/${app}/app.yaml`, appText, AppConfigSchema) : null;
    const accountsText = files?.accounts ? decode(files.accounts) : null;
    const theirsAccounts = files?.accounts ? parseFile(`apps/${app}/accounts.yaml`, accountsText, AccountsSchema) : null;
    const name = (theirsConfig?.ok ? theirsConfig.value.name : null) ?? oursValid?.config.name ?? app;
    const validConfig = theirsConfig?.ok ? theirsConfig.value : null;
    const validAccounts = theirsAccounts?.ok ? theirsAccounts.value : {};
    const view: AppView = {
      targets: new Set(Object.keys(oursValid?.config.targets ?? {})),
      accounts: oursValid?.accounts ?? {},
      mergedTargets: new Set([...Object.keys(oursValid?.config.targets ?? {}), ...Object.keys(validConfig?.targets ?? {})]),
      mergedAccounts: mergeAccounts(oursValid?.accounts ?? {}, validAccounts),
      itemKey: files ? appKey(app) : null,
      name,
    };
    views.set(app, view);
    if (!files) continue;

    const d = draft(appKey(app), "app", app, `앱 설정 · ${name}`, `${app} · ${[files.app ? "app.yaml" : null, files.accounts ? "accounts.yaml" : null].filter(Boolean).join(", ")}`);
    drafts.set(d.key, d);
    if (theirsConfig && !theirsConfig.ok) d.reasons.push(theirsConfig.reason);
    if (theirsAccounts && !theirsAccounts.ok) d.reasons.push(theirsAccounts.reason);
    if (ours !== null && "problem" in ours) d.reasons.push(`이 워크스페이스의 앱 설정을 읽지 못해 견줄 수 없습니다: ${ours.problem}`);
    if (d.reasons.length > 0) continue;
    const appPath = `apps/${app}/app.yaml`;
    const accountsPath = `apps/${app}/accounts.yaml`;
    if (!oursValid) {
      if ([...recv.fold.keys()].some((p) => p.startsWith(`apps/${app}/`))) {
        d.reasons.push(`workspace.yaml 의 앱 목록에 없는 apps/${app} 폴더가 이 워크스페이스에 있습니다`);
        continue;
      }
      if (!files.app || !validConfig) {
        d.reasons.push("이 워크스페이스에 없는 앱인데 app.yaml 이 없습니다");
        continue;
      }
      d.row = compared("app", "absent");
      d.addsApp = true;
      d.note = "이 워크스페이스에 없는 앱입니다";
      d.writes.include = new Map([[appPath, files.app], ...(files.accounts ? ([[accountsPath, files.accounts]] as const) : [])]);
      continue;
    }
    const addedTargets = Object.keys(validConfig?.targets ?? {}).filter((t) => !view.targets.has(t));
    const conflicts = Object.entries(validConfig?.targets ?? {}).filter(([t, c]) => view.targets.has(t) && oursValid.config.targets[t as Target]?.appId !== c.appId);
    const addedRoles = Object.keys(validAccounts).filter((r) => !oursValid.accounts[r]);
    const addedKeys = Object.entries(validAccounts).flatMap(([r, entry]) => (oursValid.accounts[r] ? entry.keys.filter((k) => !oursValid.accounts[r]?.keys.includes(k)) : []));
    const adds = [
      addedTargets.length ? `타깃 ${addedTargets.join(", ")}` : null,
      addedRoles.length ? `역할 ${addedRoles.join(", ")}` : null,
      addedKeys.length ? `키 ${addedKeys.join(", ")}` : null,
    ].filter((s): s is string => s !== null);
    const comparison: Comparison["app"] = conflicts.length > 0 ? "conflict" : adds.length > 0 ? "adds" : "equal";
    d.row = compared("app", comparison);
    const variant = (takeTheirs: boolean): Map<string, Uint8Array> => {
      const out = new Map<string, Uint8Array>();
      if (validConfig) {
        const text = mergeAppYaml(oursValid.appText, validConfig, takeTheirs);
        if (text !== oursValid.appText) out.set(recv.path(appPath) ?? appPath, encoder.encode(text));
      }
      if (addedRoles.length > 0 || addedKeys.length > 0) {
        const text = oursValid.accountsText === null ? accountsText : mergeAccountsYaml(oursValid.accountsText, validAccounts);
        if (text !== null) out.set(recv.path(accountsPath) ?? accountsPath, encoder.encode(text));
      }
      return out;
    };
    const keepNote = adds.length ? ` 가져오면 ${adds.join(", ")}를 더합니다.` : "";
    if (comparison === "conflict") {
      d.note = `${conflicts.map(([t, c]) => `${t} 앱 ID 가 다릅니다(이 워크스페이스 ${oursValid.config.targets[t as Target]?.appId ?? ""}, 받은 것 ${c.appId})`).join(", ")}.${keepNote} 이 워크스페이스의 것은 지우지 않습니다`;
      d.writes["keep-ours"] = variant(false);
      d.writes["take-theirs"] = variant(true);
    } else if (comparison === "adds") {
      d.note = `가져오면 ${adds.join(", ")}를 더합니다. 이 워크스페이스의 것은 지우지 않습니다`;
      d.writes.include = variant(false);
    } else d.note = "이 워크스페이스와 내용이 같습니다";
    const ourAccounts = oursValid.accountsText ?? "";
    for (const [path, mine] of [
      [appPath, oursValid.appText],
      [accountsPath, ourAccounts],
    ] as const) {
      const theirs = decode(files[path === appPath ? "app" : "accounts"]);
      if (theirs !== null && theirs !== mine && comparison !== "equal") d.compare.push({ path, ours: mine, theirs });
    }
  }

  // 가져온 뒤 그 앱·타깃의 common 폴더에 있을 서브플로우 이름. 받는 쪽 이름과 대소문자만 다른 받은 파일은 받는 쪽 이름으로 쓰므로 새 이름이 생기지 않는다
  const available = (app: string, target: string): string[] => {
    const ours = recv.common(app, target);
    const oursFolded = new Set([...ours].map(foldPath));
    const theirs = subflowFiles.filter((s) => s.app === app && s.target === target && SUBFLOW_NAME.test(s.name) && !oursFolded.has(foldPath(s.name))).map((s) => s.name);
    return [...new Set([...ours, ...theirs])];
  };
  const incomingSubflow = (app: string, target: string, name: string) => subflowFiles.some((s) => s.app === app && s.target === target && s.name === name && SUBFLOW_NAME.test(s.name));

  // 서브플로우
  const syntaxTasks: { d: Draft; what: string; text: string }[] = [];
  const subflowText = new Map<string, string | null>();
  for (const s of subflowFiles) {
    const view = views.get(s.app);
    const d = draft(subflowKey(s.app, s.target, s.name), "subflow", s.app, `공통 서브플로우 · ${s.name}`, `${s.app} · ${s.target}/common`);
    drafts.set(d.key, d);
    const text = decode(s.bytes);
    subflowText.set(d.key, text);
    if (!SUBFLOW_NAME.test(s.name)) {
      d.reasons.push("서브플로우 파일 이름은 소문자·숫자·-·_ 와 .yaml 만 받습니다");
      continue;
    }
    if (text === null) {
      d.reasons.push("UTF-8 글자가 아닙니다");
      continue;
    }
    const oursPath = recv.path(s.path);
    const ours = oursPath ? recv.tree.get(oursPath) : undefined;
    const comparison: Comparison["subflow"] = !ours ? "absent" : sameBytes(ours, s.bytes) ? "equal" : "different";
    d.row = compared("subflow", comparison);
    const siblings = available(s.app, s.target).filter((n) => foldPath(n) !== foldPath(s.name));
    // 받는 쪽에 없는 앱이나 타깃의 서브플로우는 그 앱 설정과 함께만 들어간다
    if (!recv.apps.has(s.app) || !view?.targets.has(s.target)) {
      if (view?.itemKey) d.direct.add(view.itemKey);
      else d.reasons.push(recv.apps.has(s.app) ? `타깃 ${s.target} 가 이 워크스페이스의 앱 설정에 없고, 받은 묶음에 앱 설정이 없습니다` : "이 워크스페이스에 없는 앱이고, 받은 묶음에 그 앱 설정이 없습니다");
    }
    if (!view?.mergedTargets.has(s.target)) d.reasons.push(`타깃 ${s.target} 가 앱 설정에 없습니다`);
    if (comparison !== "equal") {
      d.reasons.push(...lintReasons("서브플로우", lintSubflow(text, { envKeys: allKeys(view?.mergedAccounts ?? {}), subflows: siblings })));
      syntaxTasks.push({ d, what: "서브플로우", text });
      if (envRefs(text).some((k) => !allKeys(view?.accounts ?? {}).includes(k) && allKeys(view?.mergedAccounts ?? {}).includes(k)) && view?.itemKey) d.direct.add(view.itemKey);
      const target = oursPath ?? s.path;
      d.writes[comparison === "absent" ? "include" : "take-theirs"] = new Map([[target, s.bytes]]);
      if (comparison === "different") d.writes["keep-ours"] = new Map();
      if (comparison === "different" && ours) d.compare.push({ path: target, ours: decode(ours) ?? "(UTF-8 이 아님)", theirs: text });
    }
    for (const ref of subflowRefs(text)) {
      if (!ref.includes("/") && !recv.common(s.app, s.target).has(ref) && incomingSubflow(s.app, s.target, ref)) d.direct.add(subflowKey(s.app, s.target, ref));
    }
  }

  // 테스트 케이스: 받는 쪽에 같은 앱·번호가 있으면 견주고, 번호만 겹치면(다른 앱이나 이번 가져오기) 새 번호로 넣는다
  const groups = [...tcFiles.values()].sort((a, b) => a.app.localeCompare(b.app) || a.id.localeCompare(b.id));
  const groupPaths = (g: (typeof groups)[number], id: string) => [
    lay.testcasePath(g.app, id),
    ...[...g.flows.keys()].map((t) => lay.flowPath(g.app, t, id)),
    ...[...g.metas.keys()].map((t) => lay.metaPath(g.app, t, id)),
  ];
  const assigned = new Set<string>();
  const comparisons = new Map<string, Comparison["testcase"]>();
  for (const g of groups) {
    const present = groupPaths(g, g.id).some((p) => recv.path(p) !== undefined);
    const filesOf = (id: string) => new Map(groupPaths(g, id).map((p, i) => [p, [g.md, ...g.flows.values(), ...g.metas.values()][i]] as const));
    const comparison: Comparison["testcase"] = present
      ? [...filesOf(g.id)].every(([p, b]) => sameBytes(recv.tree.get(recv.path(p) ?? p), b))
        ? "equal"
        : "different"
      : recv.ids.has(g.id) || assigned.has(g.id)
        ? "taken"
        : "absent";
    comparisons.set(testcaseKey(g.app, g.id), comparison);
    if (comparison === "absent") assigned.add(g.id);
  }
  const reserved = new Map<string, string>();
  const reserve = (key: string) => {
    const id = nextTestcaseId([...recv.ids, ...assigned]);
    assigned.add(id);
    reserved.set(key, id);
  };
  for (const g of groups) if (comparisons.get(testcaseKey(g.app, g.id)) === "taken") reserve(testcaseKey(g.app, g.id));
  for (const g of groups) if (comparisons.get(testcaseKey(g.app, g.id)) === "different") reserve(testcaseKey(g.app, g.id));

  const tcCalls = new Map<string, string[]>();
  for (const g of groups) {
    const key = testcaseKey(g.app, g.id);
    const comparison = comparisons.get(key) ?? "absent";
    const view = views.get(g.app);
    const mdText = decode(g.md);
    const lint = mdText === null ? null : lintTestcase(mdText, { accountRoles: Object.keys(view?.mergedAccounts ?? {}), appTargets: [...(view?.mergedTargets ?? [])] }, lay.testcasePath(g.app, g.id));
    const fm = lint?.doc?.frontMatter ?? null;
    const title = fm?.title ?? "";
    const newId = reserved.get(key) ?? null;
    const flowTargets = [...g.flows.keys()];
    const d = draft(key, "testcase", g.app, `${comparison === "taken" ? `${g.id} → ${newId ?? ""}` : g.id} ${title}`.trim(), flowTargets.length ? `${g.app} · 플로우 ${flowTargets.map((t) => TARGET_LABEL[t]).join(", ")}` : g.app);
    drafts.set(key, d);
    d.renumberTo = newId;
    d.renumberFrom = newId ? g.id : null;
    if (mdText === null || !lint) {
      d.reasons.push("테스트 케이스: UTF-8 글자가 아닙니다");
      continue;
    }
    if (!fm) {
      d.reasons.push(...lintReasons("테스트 케이스", lint.issues));
      continue;
    }
    if (fm.id !== g.id) d.reasons.push(`테스트 케이스: 머리말의 id(${fm.id})가 파일 이름과 다릅니다`);
    if (fm.app !== g.app) d.reasons.push(`테스트 케이스: 머리말의 app(${fm.app})이 폴더(${g.app})와 다릅니다`);
    if (d.reasons.length > 0) continue;
    d.row = compared("testcase", comparison);
    if (comparison === "equal") {
      d.note = "이 워크스페이스와 내용이 같습니다";
      continue;
    }

    // 앱 설정이 따라와야 하는가: 받는 쪽에 없는 앱·타깃·역할·키를 쓴다
    const needed = [...new Set([...fm.targets, ...flowTargets])];
    const missingTargets = needed.filter((t) => !view?.targets.has(t));
    const missingRole = fm.account !== undefined && !view?.accounts[fm.account];
    const flowTexts = [...g.flows].map(([t, b]) => [t, decode(b)] as const);
    const missingKeys = flowTexts.some(([, text]) => text !== null && envRefs(text).some((k) => !roleKeys(view?.accounts ?? {}, fm.account).includes(k) && roleKeys(view?.mergedAccounts ?? {}, fm.account).includes(k)));
    const appAbsent = !recv.apps.has(g.app);
    if (appAbsent || missingTargets.length > 0 || missingRole || missingKeys) {
      if (view?.itemKey) d.direct.add(view.itemKey);
      else d.reasons.push(appAbsent ? "이 워크스페이스에 없는 앱이고, 받은 묶음에 그 앱 설정이 없습니다" : "이 워크스페이스의 앱 설정에 없는 타깃·역할·키를 쓰는데, 받은 묶음에 앱 설정이 없습니다");
    }
    for (const t of needed) if (!view?.mergedTargets.has(t)) d.reasons.push(`타깃 ${t} 가 앱 설정에 없습니다`);

    // 할 일마다 쓸 파일: 원래 번호(새로 넣기·덮어쓰기)와 새 번호
    const variants: { action: TransferAction; id: string }[] =
      comparison === "absent"
        ? [{ action: "include", id: g.id }]
        : comparison === "taken"
          ? [{ action: "renumber", id: newId ?? g.id }]
          : [
              { action: "overwrite", id: g.id },
              { action: "renumber", id: newId ?? g.id },
            ];
    const expectations = lint.doc?.steps.reduce((n, s) => n + s.expected.length, 0) ?? 0;
    const multi = flowTargets.length > 1;
    for (const { action, id } of variants) {
      const files = new Map<string, Uint8Array>();
      const renumber = id !== g.id;
      const rewrite = (what: string, text: string, fn: (t: string, from: string, to: string) => string | null): string | null => {
        if (!renumber) return text;
        const out = fn(text, g.id, id);
        if (out === null) d.reasons.push(`${what}: 번호를 ${id} 로 바꾸지 못했습니다(머리 모양이 예상과 다릅니다)`);
        return out;
      };
      const md = rewrite("테스트 케이스", mdText, renumberTestcaseText);
      if (md === null) break;
      const mdLint = lintTestcase(md, { accountRoles: Object.keys(view?.mergedAccounts ?? {}), appTargets: [...(view?.mergedTargets ?? [])] });
      if (mdLint.doc?.frontMatter.id !== id) d.reasons.push(`테스트 케이스: 번호를 ${id} 로 바꾸지 못했습니다`);
      if (action !== "renumber" || comparison === "taken") d.reasons.push(...lintReasons("테스트 케이스", mdLint.issues));
      files.set(lay.testcasePath(g.app, id), renumber ? encoder.encode(md) : (g.md ?? new Uint8Array()));
      for (const [target, text] of flowTexts) {
        const what = multi ? `${TARGET_LABEL[target]} 플로우` : "플로우";
        if (text === null) {
          d.reasons.push(`${what}: UTF-8 글자가 아닙니다`);
          continue;
        }
        const flow = rewrite(what, text, renumberFlowText);
        if (flow === null) continue;
        // 덮어쓰기와 새 번호는 번호만 다르다. 같은 이유가 두 번 나오지 않게 한쪽만 적는다
        if (action !== "renumber" || comparison === "taken") {
          d.reasons.push(...lintReasons(what, lintFlow(flow, { tcId: id, envKeys: roleKeys(view?.mergedAccounts ?? {}, fm.account), subflows: available(g.app, target).map((n) => `common/${n}`), expectations })));
        }
        syntaxTasks.push({ d, what, text: flow });
        files.set(lay.flowPath(g.app, target, id), renumber ? encoder.encode(flow) : (g.flows.get(target) ?? new Uint8Array()));
        const meta = g.metas.get(target);
        if (meta) {
          const metaText = decode(meta);
          const parsed = parseFile(lay.metaPath(g.app, target, g.id), metaText, FlowMetaSchema);
          if (!parsed.ok || metaText === null) {
            if (action !== "renumber" || comparison === "taken") d.reasons.push(parsed.ok ? "플로우 정보(meta): UTF-8 글자가 아닙니다" : parsed.reason);
            continue;
          }
          if (parsed.value.tc !== g.id || parsed.value.target !== target) {
            if (action !== "renumber" || comparison === "taken") d.reasons.push(`플로우 정보(meta): tc(${parsed.value.tc})·target(${parsed.value.target})이 파일 위치(${g.id}, ${target})와 다릅니다`);
            continue;
          }
          const metaOut = rewrite(`${what} 정보(meta)`, metaText, renumberMetaText);
          if (metaOut === null) continue;
          files.set(lay.metaPath(g.app, target, id), renumber ? encoder.encode(metaOut) : meta);
        }
      }
      d.writes[action] = files;
    }
    // 부르는 서브플로우: 받는 쪽에 없으면 함께 들어간다
    const calls: string[] = [];
    for (const [target, text] of flowTexts) {
      for (const ref of text === null ? [] : subflowRefs(text)) {
        if (!ref.startsWith("common/") || ref.slice(7).includes("/")) continue;
        const name = ref.slice(7);
        calls.push(`${target}/${name}`);
        if (!recv.common(g.app, target).has(name) && incomingSubflow(g.app, target, name)) d.direct.add(subflowKey(g.app, target, name));
      }
    }
    tcCalls.set(key, calls);

    const shownId = comparison === "taken" ? (newId ?? g.id) : g.id;
    const withApp = d.direct.has(appKey(g.app)) ? ` 앱 설정(${view?.name ?? g.app})도 함께 가져옵니다` : "";
    if (comparison === "absent") d.note = `이 워크스페이스에 없는 테스트 케이스입니다.${withApp}`.trim();
    else if (comparison === "taken") {
      const theirTitle = recv.titles.get(g.id);
      d.note = `${recv.ids.has(g.id) ? `이 워크스페이스의 ${g.id}${theirTitle ? `(${theirTitle})` : ""}과 다른 테스트입니다. ` : "번호가 겹쳐 "}새 번호(${shownId})로 가져오고 플로우의 이름과 태그도 함께 바꿉니다.${withApp}`;
    } else {
      const ourPaths = groupPaths(g, g.id);
      const parts: string[] = [];
      ourPaths.forEach((path, i) => {
        const theirs = [g.md, ...g.flows.values(), ...g.metas.values()][i];
        const oursPath = recv.path(path);
        const ours = oursPath ? recv.tree.get(oursPath) : undefined;
        if (sameBytes(ours, theirs)) return;
        const info = lay.parse(path);
        parts.push(info?.kind === "flow" ? `${TARGET_LABEL[info.target]} 플로우${info.meta ? " 정보" : ""}` : "테스트 케이스");
        d.compare.push({ path, ours: ours ? (decode(ours) ?? "(UTF-8 이 아님)") : "(없음)", theirs: theirs ? (decode(theirs) ?? "(UTF-8 이 아님)") : "" });
      });
      d.note = `같은 앱, 같은 번호입니다. ${parts.join(", ")}가 다릅니다.${withApp}`;
    }
  }

  // Maestro 문법 검사(같은 글자는 한 번만)
  const runLimited = limiter(SYNTAX_CONCURRENCY);
  const syntax = new Map<string, Promise<string | null>>();
  for (const task of syntaxTasks) {
    if (!syntax.has(task.text)) {
      syntax.set(
        task.text,
        runLimited(() => checks.checkFlowSyntax(task.text)).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
  }
  const syntaxResults = new Map<string, string | null>();
  for (const [text, result] of syntax) syntaxResults.set(text, await result);
  for (const task of syntaxTasks) {
    const reason = syntaxResults.get(task.text);
    const line = reason ? `${task.what}: ${reason}` : null;
    if (line && !task.d.reasons.includes(line)) task.d.reasons.push(line);
  }

  // 함께 들어가는 항목(이어서 부르는 것까지)과 받지 않는 항목의 전파
  const closure = (key: string): string[] => {
    const seen = new Set<string>();
    const stack = [...(drafts.get(key)?.direct ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() ?? "";
      if (seen.has(next) || next === key) continue;
      seen.add(next);
      stack.push(...(drafts.get(next)?.direct ?? []));
    }
    return [...seen].sort();
  };
  const requires = new Map([...drafts.keys()].map((k) => [k, closure(k)]));
  const rejected = new Set([...drafts.values()].filter((d) => d.reasons.length > 0).map((d) => d.key));
  for (const d of drafts.values()) {
    if (rejected.has(d.key)) continue;
    const blocked = (requires.get(d.key) ?? []).filter((k) => rejected.has(k));
    if (blocked.length > 0) d.reasons.push(`함께 들어가야 하는 ${blocked.map((k) => drafts.get(k)?.label ?? k).join(", ")}을(를) 받지 않아 받지 않습니다`);
  }

  // 서브플로우를 부르는 테스트 케이스(이어서 부르는 것까지)
  const callers = new Map<string, Set<string>>();
  for (const [key, calls] of tcCalls) {
    const d = drafts.get(key);
    if (!d || d.reasons.length > 0) continue;
    const shown = comparisons.get(key) === "taken" ? (d.renumberTo ?? "") : (key.split(":")[2] ?? "");
    const seen = new Set<string>();
    const stack = [...calls];
    while (stack.length > 0) {
      const next = stack.pop() ?? "";
      if (seen.has(next)) continue;
      seen.add(next);
      const [target = "", name = ""] = next.split("/");
      const sk = subflowKey(d.app, target, name);
      const set = callers.get(sk) ?? new Set<string>();
      set.add(shown);
      callers.set(sk, set);
      const oursPath = recv.path(`${lay.commonDir(d.app, target)}/${name}`);
      const ownText = subflowText.get(sk) ?? (oursPath ? decode(recv.tree.get(oursPath)) : null);
      for (const ref of ownText === null ? [] : subflowRefs(ownText)) if (!ref.includes("/")) stack.push(`${target}/${ref}`);
    }
  }
  for (const d of drafts.values()) {
    if (d.kind !== "subflow" || d.reasons.length > 0) continue;
    const by = [...(callers.get(d.key) ?? [])].sort();
    const usedBy = by.length ? `${by.join(", ")} 의 플로우가 부릅니다.` : "";
    d.note = d.row?.status === "same" ? "이 워크스페이스와 내용이 같습니다" : d.row?.status === "new" ? usedBy || "이 워크스페이스에 없는 서브플로우입니다" : `${usedBy} 내용이 다릅니다`.trim();
  }

  const items: TransferItem[] = [...drafts.values()].map((d) => {
    const row = d.reasons.length > 0 || d.row === null ? REJECTED : d.row;
    return {
      key: d.key,
      kind: d.kind,
      app: d.app,
      label: d.label,
      detail: d.detail,
      status: row.status,
      note: row === REJECTED ? d.reasons.join(" / ") : d.note,
      choices: row.choices,
      defaultChoice: row.defaultChoice,
      requires: row === REJECTED ? [] : (requires.get(d.key) ?? []),
      renumberTo: row === REJECTED ? null : d.renumberTo,
      compare: row === REJECTED ? [] : d.compare,
    };
  });
  // 고를 수 있는 것을 앞에(앱 → 앱 설정·테스트 케이스·서브플로우 순), 받지 않음, 같음 순
  const group = (i: TransferItem) => (i.status === "rejected" ? 1 : i.status === "same" ? 2 : 0);
  const kindOrder: Record<TransferItemKind, number> = { app: 0, testcase: 1, subflow: 2 };
  items.sort((a, b) => group(a) - group(b) || a.app.localeCompare(b.app) || kindOrder[a.kind] - kindOrder[b.kind] || a.key.localeCompare(b.key));
  const summary = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length])) as Record<TransferItemStatus, number>;
  const byKey = new Map(items.map((i) => [i.key, i]));

  return {
    ok: true,
    plan: {
      items,
      skipped,
      summary,
      apply(picks) {
        const chosen = new Map<string, TransferAction>();
        for (const pick of picks) {
          const item = byKey.get(pick.key);
          if (!item) throw new ImportPickError(`미리보기에 없는 항목이다: ${pick.key}`);
          if (chosen.has(pick.key)) throw new ImportPickError(`같은 항목을 두 번 골랐다: ${item.label}`);
          if (!item.choices.includes(pick.action)) throw new ImportPickError(`${item.label}: 고를 수 없는 할 일이다(${pick.action})`);
          chosen.set(pick.key, pick.action);
        }
        for (const key of [...chosen.keys()]) {
          for (const need of byKey.get(key)?.requires ?? []) {
            if (chosen.has(need)) continue;
            const action = byKey.get(need)?.defaultChoice;
            if (!action) throw new ImportPickError(`함께 들어가야 하는 항목을 넣을 수 없다: ${byKey.get(need)?.label ?? need}`);
            chosen.set(need, action);
          }
        }
        const files = new Map<string, Uint8Array>();
        const folded = new Map<string, string>();
        const newApps: string[] = [];
        const renumbered: { from: string; to: string }[] = [];
        const picked: ImportWrites["picked"] = [];
        for (const [key, action] of chosen) {
          const d = drafts.get(key);
          const item = byKey.get(key);
          if (!d || !item) continue;
          picked.push({ item, action });
          for (const [path, bytes] of d.writes[action] ?? new Map<string, Uint8Array>()) {
            const other = folded.get(foldPath(path));
            if (other !== undefined) throw new ImportPickError(`두 항목이 같은 파일을 쓴다: ${other}, ${path}`);
            folded.set(foldPath(path), path);
            files.set(path, bytes);
          }
          if (d.addsApp && action === "include") newApps.push(d.app);
          if (action === "renumber" && d.renumberFrom && d.renumberTo) renumbered.push({ from: d.renumberFrom, to: d.renumberTo });
        }
        if (newApps.length > 0) files.set("workspace.yaml", encoder.encode(newApps.sort().reduce((text, app) => addAppToWorkspaceYaml(text, app), recv.workspaceText)));
        if (files.size === 0) throw new ImportPickError("쓸 것이 없다. 고른 항목이 모두 이 워크스페이스 것 그대로다");
        return { files, renumbered: renumbered.sort((a, b) => a.from.localeCompare(b.from)), picked };
      },
    },
  };
}
