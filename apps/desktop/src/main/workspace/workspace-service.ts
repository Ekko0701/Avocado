import type { AccountRoleEdit, AppSettingsDoc, ExportInfo, ExportResult, GitHubSettings, ImportApplyInput, ImportApplyResult, ImportPickResult, ImportSource, RequestReviewResult, SaveAppSettingsInput, SaveAppSettingsResult, SaveSubflowInput, SaveSubflowResult, SaveTestcaseResult, Subflow, SubflowList, TestcaseHistory, TestcaseList, TransferItemKind, WorkBranch, WorkBranchList, WorkspaceAccounts, WorkspaceSourceKind, WorkspaceStatus } from "@qa/shared";
import { AppIdSchema, AppTargetSchema, githubWorkspaceRefusal, localWorkspaceRefusal, SaveSubflowInputSchema, WorkBranchNameSchema } from "@qa/shared";
import { runGit, runGitBytes, type AskpassServer, type RemoteProvider } from "@qa/remote";
import {
  AccountsSchema,
  addAppToWorkspaceYaml,
  AppConfigSchema,
  defaultSubflows,
  hasBlocking,
  ImportPickError,
  LATEST_LAYOUT,
  layoutForSchemaVersion,
  layoutOf,
  lintSubflow,
  lintTestcase,
  loadWorkspace,
  MAX_ZIP_FILE_BYTES,
  planImport,
  readFolder,
  readZip,
  TC_ID,
  WorkspaceConfigSchema,
  type Accounts,
  type AppConfig,
  type ArchiveRead,
  type ImportPlan,
  type Target,
  type WorkspaceLayout,
} from "@qa/workspace";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { Document, parse as parseYaml, parseDocument, visit } from "yaml";
import { commitImportBranch, commitLocalImport, readTree } from "./import-commit";
import { WorkspaceError } from "./workspace-error";

export { WorkspaceError };

export interface WorkspaceServiceOptions {
  /** userData/workspaces */
  root: string;
  /** 워크스페이스의 출처(설정의 workspace.source, ADR 0036) */
  source: () => WorkspaceSourceKind;
  /** 출처를 설정에 저장한다 */
  saveSource: (source: WorkspaceSourceKind) => void;
  /** 로컬 워크스페이스 폴더(userData/local-workspace) */
  localDir: string;
  /** 로컬 워크스페이스의 커밋 작성자 이름(이 Mac 의 계정 이름) */
  localAuthor: string;
  remote: RemoteProvider;
  github: () => GitHubSettings;
  token: () => string | null;
  /** git 인증 도우미(앱이 처음 쓸 때 띄운다) */
  askpass: () => Promise<AskpassServer>;
  /** git 전역 설정을 읽을 홈. 기본 사용자 홈 */
  home?: string;
  /**
   * 작업 브랜치를 바꾸면 안 되는 이유(진행 중인 플로우 만들기·실행이 워크스페이스 파일을 읽고 쓴다). 없으면 null.
   * except: "author" 는 플로우 만들기가 스스로 옮길 때 그 작업은 빼고 본다
   */
  busy?: (except?: "author") => string | null;
  /** 앱이 관리하는 Maestro 로 플로우 YAML 문법을 검사한다(check-syntax). 오류면 이유를 담아 던진다 */
  checkFlowSyntax: (text: string) => Promise<void>;
  /** 폴더를 Finder 에서 연다(shell.openPath). 실패하면 이유, 성공하면 빈 문자열 */
  openFolder: (path: string) => Promise<string>;
  /** main 이 연 창에서 가져올 zip(file)이나 폴더(folder)를 고른다. 닫으면 null(렌더러는 경로를 넘기지 않는다). 없으면 가져오기를 거절한다 */
  pickImport?: (from: "file" | "folder") => Promise<string | null>;
  /** main 이 연 저장 창에서 내보낼 zip 의 위치를 고른다. 닫으면 null. 없으면 내보내기를 거절한다 */
  pickExportPath?: (defaultName: string) => Promise<string | null>;
}

/** 화면에 보이는 경로: 홈 폴더 아래면 ~ 로 줄인다 */
export function displayPath(path: string, home: string): string {
  const base = home.endsWith(sep) ? home.slice(0, -1) : home;
  if (path === base) return "~";
  return path.startsWith(`${base}${sep}`) ? `~${path.slice(base.length)}` : path;
}

const MAIN = "main";

/** 워크스페이스가 있는 곳(ADR 0036 결정 5). 출처에 따라 달라지는 것은 이 값에서만 읽는다 */
type WorkspaceSource =
  | { kind: "local"; dir: string; author: { name: string; email: string } }
  | { kind: "github"; dir: string; owner: string; repo: string };

/** 새 로컬 워크스페이스의 workspace.yaml. 앱은 워크스페이스 화면에서 등록한다 */
const LOCAL_WORKSPACE_YAML = `# 이 Mac 에서 혼자 쓰는 로컬 워크스페이스. 앱 목록과 기본값.
schemaVersion: ${LATEST_LAYOUT}
name: local-workspace
apps: []
`;

/** 워크스페이스 전체를 바꾸는 작업 범위(폴더 구조 바꾸기, ADR 0032). 브랜치는 qa/<login>/workspace/<요약> */
const WORKSPACE_SCOPE = "workspace";
/** 앱 설정(app.yaml·accounts.yaml) 작업 범위 */
const appScope = (app: string) => `app/${app}`;
/** 가져오기 브랜치(qa/<login>/import/<요약>[-n]). 가져올 때마다 새 브랜치이고 그 브랜치 하나가 범위 하나다(ADR 0036 결정 11) */
const IMPORT_SCOPE = "import/";
const LOCAL_WORKSPACE_LABEL = "이 Mac 의 로컬 워크스페이스";
const IMPORT_KIND_LABEL: Record<TransferItemKind, string> = { testcase: "테스트 케이스", app: "앱 설정", subflow: "공통 서브플로우" };

/**
 * 작업 브랜치가 맡은 일(작업 범위): TC 는 "TC-0101"(qa/<login>/TC-0101-…), 앱 설정은 "app/<앱>"(qa/<login>/app/<앱>/…).
 * 예전 계정 역할 브랜치(qa/<login>/accounts/<앱>/…)도 그 앱의 앱 설정 범위다. 내 작업 브랜치가 아니면 null. 범위 하나에 브랜치 하나, PR 하나다
 */
export function workBranchScope(branch: string, login: string): string | null {
  const prefix = `qa/${login}/`;
  if (!branch.startsWith(prefix)) return null;
  const rest = branch.slice(prefix.length);
  const tc = /^(TC-\d{4,})(?:-|$)/.exec(rest)?.[1];
  if (tc) return tc;
  const app = /^(?:app|accounts)\/([a-z0-9][a-z0-9-]{0,39})\//.exec(rest)?.[1];
  if (app) return appScope(app);
  if (rest.startsWith(IMPORT_SCOPE)) return rest;
  return rest.startsWith("workspace/") ? WORKSPACE_SCOPE : null;
}

/** qa/<login>/<TC-id>-… 작업 브랜치의 TC id. TC 작업 브랜치가 아니면 null */
export function workBranchTc(branch: string, login: string): string | null {
  const scope = workBranchScope(branch, login);
  return scope?.startsWith("TC-") ? scope : null;
}



/** 플로우 만들기 입력(PLAN 6.5 1) */
export interface AuthorContext {
  /** 워크스페이스 clone 폴더 */
  dir: string;
  tcPath: string;
  /** 워크스페이스 기준 플로우 경로(구조에 따라 flows/<app>/<target>/<TC>.yaml 또는 apps/<app>/flows/<target>/<TC>.yaml) */
  flowPath: string;
  metaPath: string;
  tc: { id: string; title: string; markdown: string; steps: number; expectations: number };
  envKeys: string[];
  /** app.yaml 의 타깃 앱 id */
  appId: string;
  locale: string | null;
  /** 플로우 폴더 기준 상대 경로(common/…)와 내용 */
  subflows: { path: string; text: string }[];
  /** TC 파일의 마지막 커밋. 저장하지 않은 변경이 있으면 uncommitted */
  tcVersion: string;
}

/** 브랜치 이름에 쓸 짧은 영문 요약. 한글만 있으면 edit */
export function branchSlug(summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return slug || "edit";
}

/** 고른 zip 파일을 읽는다. 상한보다 크면 읽지 않는다 */
function readZipFile(path: string): ArchiveRead {
  const st = statSync(path);
  if (!st.isFile()) return { ok: false, problems: [{ path: "", code: "type", message: "zip 파일이 아닙니다" }] };
  if (st.size > MAX_ZIP_FILE_BYTES) return { ok: false, problems: [{ path: "", code: "size", message: "zip 파일이 너무 큽니다" }] };
  return readZip(readFileSync(path));
}

/** 앱 설정 파일 본문. 앞쪽 설명 주석은 그대로 두고(없으면 defaultHeader), 목록은 한 줄([A, B])로 쓴다 */
function yamlText(value: unknown, previous: string | null, defaultHeader: string): string {
  const header: string[] = [];
  for (const line of previous?.split("\n") ?? []) {
    if (!line.startsWith("#")) break;
    header.push(line);
  }
  const head = header.length > 0 ? header.join("\n") : defaultHeader;
  const doc = new Document(value);
  visit(doc, {
    Seq(_key, node) {
      node.flow = true;
    },
  });
  return `${head}\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}`;
}

/** 키 순서와 상관없이 같은 값인가(파일을 다시 쓸지 정할 때. 주석·모양만 다르면 같다) */
function sameData(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** accounts.yaml 본문 */
export function accountsYaml(app: string, accounts: Accounts, previous: string | null): string {
  return yamlText(accounts, previous, `# 계정 역할 → 키 이름. 값은 두지 않는다. 각자 앱 설정 화면에서 account:${app}:<KEY> 로 저장한다.`);
}

/** 테스트 케이스 계정 역할의 키. 역할이 없으면 빈 목록이다. 플로우 만들기와 실행이 이 기준 하나를 쓴다 */
const roleKeys = (accounts: Accounts, role: string | undefined): string[] => (role ? [...(accounts[role]?.keys ?? [])] : []);
const toRoleEdits = (accounts: Accounts): AccountRoleEdit[] => Object.entries(accounts).map(([role, r]) => ({ role, description: r.description, keys: [...r.keys] }));

/**
 * 워크스페이스 저장소(PLAN 4.4). clone·동기화·작업 브랜치·커밋·푸시·PR.
 * - main 에 직접 푸시하지 않는다. TC·플로우를 저장하면 그 TC 의 작업 브랜치(qa/<login>/<TC>-<요약>)에 커밋한다.
 *   TC 하나에 작업 브랜치 하나, PR 하나다. 다른 TC 의 작업 브랜치에는 섞지 않는다.
 * - 원격 인증은 GIT_ASKPASS 도우미로만 한다(ADR 0013). 원격 주소에 토큰이 없다.
 * - 동기화는 main 이 깨끗할 때만 fast-forward 한다. 충돌은 앱이 풀지 않는다.
 */
export class WorkspaceService {
  /** 토큰별 로그인 이름(토큰을 바꾸면 다시 묻는다) */
  private login: { token: string; login: string } | null = null;
  /** 진행 중인 로컬 저장소 만들기(동시에 불러도 한 번만 만든다) */
  private creatingLocal: Promise<void> | null = null;
  /** 마지막 가져오기 미리보기. 반영은 이때 읽은 바이트만 쓴다(원본을 다시 읽지 않는다) */
  private pendingImport: { id: string; kind: WorkspaceSourceKind; dir: string; base: string; label: string; plan: ImportPlan } | null = null;

  constructor(private readonly options: WorkspaceServiceOptions) {}

  private localSource(): Extract<WorkspaceSource, { kind: "local" }> {
    const name = this.options.localAuthor;
    return { kind: "local", dir: this.options.localDir, author: { name, email: `${name}@avocado.local` } };
  }

  /** 지금 출처의 워크스페이스. GitHub 인데 조직을 정하기 전이면 null */
  private source(): WorkspaceSource | null {
    if (this.options.source() === "local") return this.localSource();
    const g = this.options.github();
    return g.owner ? { kind: "github", dir: join(this.options.root, g.workspaceRepo), owner: g.owner, repo: g.workspaceRepo } : null;
  }

  private target(): WorkspaceSource {
    const source = this.source();
    if (!source) throw new WorkspaceError("GitHub 조직 이름을 먼저 설정한다");
    return source;
  }

  /** 원격이 필요한 기능(ADR 0036 결정 6). 로컬이면 한 문장으로 거절하고, GitHub 이면 그 저장소를 돌려준다 */
  private requireGithub(what: string): Extract<WorkspaceSource, { kind: "github" }> {
    const source = this.target();
    if (source.kind === "local") throw new WorkspaceError(localWorkspaceRefusal(what));
    return source;
  }

  /** 화면과 플로우 만들기의 안내 문구가 보는 출처 */
  sourceKind(): WorkspaceSourceKind {
    // source() 가 null 인 것은 조직을 정하기 전의 GitHub 뿐이다
    return this.source()?.kind ?? "github";
  }

  /** 이 워크스페이스의 폴더 구조(ADR 0032). 경로는 여기서 받은 것으로만 만든다 */
  private layout(): WorkspaceLayout {
    return layoutOf(this.target().dir);
  }

  /** raw: 출력을 자르지 않는다(파일 내용을 읽을 때) */
  private async git(args: string[], opts: { auth?: boolean; cwd?: string; raw?: boolean; env?: Record<string, string>; input?: Uint8Array } = {}): Promise<string> {
    const token = this.options.token();
    let session: ReturnType<AskpassServer["session"]> | undefined;
    if (opts.auth) {
      if (!token) throw new WorkspaceError("GitHub 토큰이 없다. 설정에서 저장한다");
      session = (await this.options.askpass()).session({ username: "x-access-token", password: token });
    }
    try {
      const r = await runGit(args, { cwd: opts.cwd ?? this.target().dir, askpass: session, secrets: token ? [token] : [], home: this.options.home, timeoutMs: 180_000, env: opts.env, input: opts.input });
      if (r.code !== 0) throw new WorkspaceError(`git ${args[0] ?? ""} 실패: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return opts.raw ? r.stdout : r.stdout.trim();
    } finally {
      session?.dispose();
    }
  }

  /** 파일 내용을 바이트로 읽는 git(cat-file). 원격 인증을 쓰지 않는다 */
  private async gitBytes(args: string[], opts: { cwd?: string; input?: Uint8Array } = {}): Promise<Buffer> {
    const r = await runGitBytes(args, { cwd: opts.cwd ?? this.target().dir, home: this.options.home, timeoutMs: 180_000, input: opts.input });
    if (r.code !== 0) throw new WorkspaceError(`git ${args[0] ?? ""} 실패: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
    return r.stdout;
  }

  /** 커밋 작성자. GitHub 는 로그인 이름(API)과 noreply 주소, 로컬은 이 Mac 의 계정 이름과 로컬 전용 주소(원격에 묻지 않는다) */
  private async author(): Promise<{ name: string; email: string }> {
    const source = this.target();
    if (source.kind === "local") return source.author;
    const token = this.options.token() ?? "";
    if (!this.login || this.login.token !== token) this.login = { token, login: (await this.options.remote.verify([])).login };
    return { name: this.login.login, email: `${this.login.login}@users.noreply.github.com` };
  }

  /** 커밋할 때 git 에 넘기는 작성자 인자 */
  private async authorArgs(): Promise<string[]> {
    const { name, email } = await this.author();
    return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
  }

  /** 작업 브랜치 이름(qa/<이름>/…)에 쓰는 내 이름 */
  private async whoami(): Promise<string> {
    return (await this.author()).name;
  }

  connected(): boolean {
    const source = this.source();
    return source !== null && existsSync(join(source.dir, ".git"));
  }

  /**
   * 로컬 워크스페이스 저장소를 만든다(ADR 0036 결정 3). 이미 있으면 아무것도 하지 않는다.
   * 옆의 임시 폴더에서 첫 커밋까지 끝낸 뒤 이름을 바꿔 제자리에 둔다. 그래서 .git 이 있으면 커밋도 있다
   * (커밋 없는 저장소는 git rev-parse HEAD 가 실패해 모든 화면이 오류가 된다)
   */
  ensureLocal(): Promise<void> {
    this.creatingLocal ??= this.createLocal().finally(() => {
      this.creatingLocal = null;
    });
    return this.creatingLocal;
  }

  private async createLocal(): Promise<void> {
    const { dir, author } = this.localSource();
    if (existsSync(join(dir, ".git"))) return;
    if (existsSync(dir)) throw new WorkspaceError(`로컬 워크스페이스 폴더가 이미 있지만 git 저장소가 아니다: ${dir}`);
    const building = `${dir}.creating`;
    // 만들다 멈춘 이전 시도의 임시 폴더는 버리고 처음부터 다시 만든다
    rmSync(building, { recursive: true, force: true });
    mkdirSync(building, { recursive: true, mode: 0o700 });
    writeFileSync(join(building, "workspace.yaml"), LOCAL_WORKSPACE_YAML);
    await this.git(["init", "--quiet", "--initial-branch", MAIN], { cwd: building });
    await this.git(["add", "--", "workspace.yaml"], { cwd: building });
    await this.git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "-m", "workspace: 로컬 워크스페이스를 만든다"], { cwd: building });
    renameSync(building, dir);
  }

  /**
   * 출처를 바꾼다(ADR 0036 결정 10). 플로우 저장은 저장하는 순간의 출처 폴더에 쓰므로 실행·플로우 만들기 중에는 바꾸지 않는다.
   * 두 출처는 폴더가 따로이고 내용을 옮기지 않는다
   */
  async setSource(source: WorkspaceSourceKind): Promise<WorkspaceStatus> {
    const busy = this.options.busy?.();
    if (busy) throw new WorkspaceError(`${busy}. 끝난 뒤 워크스페이스 출처를 바꾼다`);
    if (source === "local") await this.ensureLocal();
    this.options.saveSource(source);
    return this.status();
  }

  async status(): Promise<WorkspaceStatus> {
    const current = this.source();
    // 화면이 가장 먼저 부르는 곳이다. 로컬이면 여기서 저장소가 있게 한다
    if (current?.kind === "local") await this.ensureLocal();
    const source = this.sourceKind();
    const repo = current?.kind === "github" ? `${current.owner}/${current.repo}` : null;
    const location = current?.kind === "local" ? displayPath(current.dir, this.options.home ?? homedir()) : null;
    if (!this.connected()) return { source, connected: false, repo, branch: null, head: null, onMain: false, dirty: [], ahead: 0, behind: 0, issues: 0, layout: null, location };
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const head = await this.git(["rev-parse", "--short", "HEAD"]);
    const dirty = await this.dirtyFiles();
    let ahead = 0;
    let behind = 0;
    const hasOriginMain = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${MAIN}`]).then(
      () => true,
      () => false,
    );
    if (hasOriginMain) {
      const [a, b] = (await this.git(["rev-list", "--left-right", "--count", `HEAD...origin/${MAIN}`])).split(/\s+/).map(Number);
      ahead = a ?? 0;
      behind = b ?? 0;
    }
    return { source, connected: true, repo, branch, head, onMain: branch === MAIN, dirty, ahead, behind, issues: loadWorkspace(this.target().dir).issues.length, layout: this.layout().version, location };
  }

  /** 로컬 워크스페이스 폴더를 Finder 에서 연다. 폴더는 이 서비스가 아는 것만 연다(화면은 경로를 넘기지 않는다) */
  async reveal(): Promise<{ opened: true }> {
    const source = this.target();
    if (source.kind !== "local") throw new WorkspaceError(githubWorkspaceRefusal("Finder 에서 열기"));
    await this.ensureLocal();
    const error = await this.options.openFolder(source.dir);
    if (error) throw new WorkspaceError(`Finder 에서 열지 못했다: ${error}`);
    return { opened: true };
  }

  /** 처음이면 clone 한다. 이미 있으면 그대로 둔다 */
  async connect(): Promise<WorkspaceStatus> {
    const { owner, repo, dir } = this.requireGithub("저장소 연결(clone)");
    if (!this.connected()) {
      if (existsSync(dir)) throw new WorkspaceError(`워크스페이스 폴더가 이미 있지만 git 저장소가 아니다: ${dir}`);
      mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
      await this.git(["clone", "--quiet", this.options.remote.cloneUrl({ owner, repo }), repo], { auth: true, cwd: this.options.root });
    }
    return this.status();
  }

  /** git fetch 후, main 이고 변경이 없으면 fast-forward. 작업 브랜치는 그대로 둔다(PLAN 4.4 의 1) */
  async sync(): Promise<WorkspaceStatus> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    this.requireGithub("동기화");
    await this.git(["fetch", "--quiet", "--prune", "origin"], { auth: true });
    const s = await this.status();
    if (s.onMain && s.dirty.length === 0 && s.behind > 0) await this.git(["merge", "--ff-only", "--quiet", `origin/${MAIN}`]);
    return this.status();
  }

  async testcases(): Promise<TestcaseList> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const ws = loadWorkspace(this.target().dir);
    const locks = await this.importLocks();
    return {
      testcases: ws.testcases.map((t) => ({
        app: t.app,
        id: t.id,
        path: t.path,
        title: t.doc?.frontMatter.title ?? null,
        status: t.doc?.frontMatter.status ?? null,
        targets: t.doc?.frontMatter.targets ?? [],
        tags: t.doc?.frontMatter.tags ?? [],
        valid: t.doc !== null && !ws.issues.some((i) => i.path === t.path),
        flows: [...new Set(ws.flows.filter((f) => f.app === t.app && f.tcId === t.id).map((f) => f.target))],
        lockedBy: this.lockFor(locks, ws.layout, (info) => (info.kind === "testcase" || info.kind === "flow") && info.app === t.app && info.id === t.id),
      })),
      apps: Object.entries(ws.apps).map(([app, a]) => ({
        app,
        name: a.config?.name ?? app,
        targets: Object.keys(a.config?.targets ?? {}),
        accountRoles: Object.keys(a.accounts),
      })),
      issues: ws.issues,
    };
  }

  /** 앱마다 필요한 테스트 계정 값의 키 이름(accounts.yaml). 값은 없다. 연결 전이면 빈 목록 */
  accounts(): WorkspaceAccounts {
    if (!this.connected()) return { connected: false, apps: [] };
    const ws = loadWorkspace(this.target().dir);
    return {
      connected: true,
      apps: Object.entries(ws.apps).map(([app, a]) => ({
        app,
        name: a.config?.name ?? app,
        roles: Object.entries(a.accounts).map(([role, r]) => ({ role, description: r.description, keys: [...r.keys] })),
      })),
    };
  }

  /** 앱 설정(이름·언어·타깃별 앱 ID·계정 역할) 편집용. 그 앱의 진행 중인 앱 설정 브랜치가 있으면 거기서, 없으면 지금 브랜치에서 읽는다 */
  async readApp(app: string): Promise<AppSettingsDoc> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const appId = AppIdSchema.parse(app);
    const source = await this.appSource(appId);
    return {
      app: appId,
      exists: source.exists,
      name: source.config?.name ?? "",
      locale: source.config?.locale ?? null,
      targets: Object.entries(source.config?.targets ?? {}).map(([target, t]) => ({
        target: AppTargetSchema.parse(target),
        appId: t.appId,
        scheme: t.build?.scheme ?? null,
        configuration: t.build?.configuration ?? null,
      })),
      roles: toRoleEdits(source.accounts),
      branch: source.branch,
    };
  }

  /**
   * 앱 설정을 저장한다: 형식과 지금 TC·플로우가 쓰는 타깃·역할·키를 검사하고, 이 앱의 앱 설정 작업 브랜치(qa/<login>/app/<앱>/…)에
   * app.yaml·accounts.yaml(새 앱이면 workspace.yaml 앱 목록까지)만 커밋한다. 검사는 브랜치를 옮기기 전에 한다(막히면 빈 브랜치가 남지 않는다).
   */
  async saveApp(input: SaveAppSettingsInput): Promise<SaveAppSettingsResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const app = AppIdSchema.parse(input.app);
    const { dir } = this.target();
    const source = await this.appSource(app);
    if (input.create && source.exists) throw new WorkspaceError(`이미 있는 앱이다: ${app}`);
    if (input.create && existsSync(join(dir, "apps", app))) throw new WorkspaceError(`apps/${app} 폴더가 이미 있다`);
    if (!input.create && !source.exists) throw new WorkspaceError(`workspace.yaml 에 없는 앱이다: ${app}`);

    // 앱 설정: 메모·빌드 정보는 그대로 둔다
    const kinds = input.targets.map((t) => t.target);
    const twice = [...new Set(kinds.filter((k, i) => kinds.indexOf(k) !== i))];
    if (twice.length > 0) throw new WorkspaceError(`같은 타깃이 두 번 있다: ${twice.join(", ")}`);
    const targets: AppConfig["targets"] = {};
    for (const t of input.targets) {
      const appId = t.appId.trim();
      if (!appId || /\s/.test(appId)) throw new WorkspaceError(`${t.target} 앱 ID 를 공백 없이 쓴다`);
      // 메모·스크립트는 그대로 두고, 화면이 넘긴 스킴·구성만 바꾼다(빈 값이면 없앤다, 넘기지 않으면 그대로)
      const { scheme: oldScheme, configuration: oldConfiguration, ...kept } = source.config?.targets[t.target]?.build ?? {};
      const scheme = t.scheme === undefined ? oldScheme : t.scheme?.trim() || undefined;
      const configuration = t.configuration === undefined ? oldConfiguration : t.configuration?.trim() || undefined;
      const build = { ...kept, ...(scheme ? { scheme } : {}), ...(configuration ? { configuration } : {}) };
      targets[t.target] = Object.keys(build).length > 0 ? { appId, build } : { appId };
    }
    const locale = input.locale?.trim() || undefined;
    const note = source.config?.note;
    const parsedConfig = AppConfigSchema.safeParse({ name: input.name.trim(), ...(locale ? { locale } : {}), ...(note !== undefined ? { note } : {}), targets });
    if (!parsedConfig.success) throw new WorkspaceError(`앱 설정 형식 오류: ${parsedConfig.error.issues.map((i) => `${i.path.join(".") || "app"}: ${i.message}`).join(" / ")}`);

    // 계정 역할
    const roles = input.roles.map((r) => ({ role: r.role.trim(), description: r.description.trim(), keys: [...new Set(r.keys.map((k) => k.trim()).filter(Boolean))] }));
    const duplicated = [...new Set(roles.map((r) => r.role).filter((r, i, all) => all.indexOf(r) !== i))];
    if (duplicated.length > 0) throw new WorkspaceError(`같은 역할 이름이 두 번 있다: ${duplicated.join(", ")}`);
    const parsedAccounts = AccountsSchema.safeParse(Object.fromEntries(roles.map((r) => [r.role, { description: r.description, keys: r.keys }])));
    if (!parsedAccounts.success) {
      throw new WorkspaceError(`계정 역할 형식 오류: ${parsedAccounts.error.issues.map((i) => `${i.path.join(".") || "accounts"}: ${i.message}`).join(" / ")}`);
    }
    const nextAccounts = parsedAccounts.data;

    // 지금 워크스페이스의 TC·플로우가 쓰는 타깃·역할·키는 지우지 않는다
    const ws = loadWorkspace(dir);
    const tcs = ws.testcases.filter((t) => t.app === app && t.doc);
    const lostTargets = Object.keys(source.config?.targets ?? {})
      .filter((target) => !(target in targets))
      .map((target) => [target, [...tcs.filter((t) => t.doc?.frontMatter.targets.some((x) => x === target)).map((t) => t.id), ...this.flowFiles(this.layout().flowDir(app, target))]] as const)
      .filter(([, users]) => users.length > 0);
    if (lostTargets.length > 0) throw new WorkspaceError(`테스트 케이스·플로우가 쓰는 타깃은 지울 수 없다: ${lostTargets.map(([t, users]) => `${t}(${users.join(", ")})`).join(" / ")}`);
    const usedRoles = new Map<string, string[]>();
    for (const t of tcs) {
      const role = t.doc?.frontMatter.account;
      if (role) usedRoles.set(role, [...(usedRoles.get(role) ?? []), t.id]);
    }
    const lostRoles = [...usedRoles].filter(([role]) => !nextAccounts[role]);
    if (lostRoles.length > 0) throw new WorkspaceError(`테스트 케이스가 쓰는 역할은 지울 수 없다: ${lostRoles.map(([r, ids]) => `${r}(${ids.join(", ")})`).join(" / ")}`);
    const knownKeys = new Set(Object.values({ ...(ws.apps[app]?.accounts ?? {}), ...source.accounts }).flatMap((r) => r.keys));
    const nextKeys = new Set(Object.values(nextAccounts).flatMap((r) => r.keys));
    const lostKeys = [...this.flowKeyUses(app, knownKeys)].filter(([key]) => !nextKeys.has(key));
    if (lostKeys.length > 0) throw new WorkspaceError(`플로우가 쓰는 키는 지울 수 없다: ${lostKeys.map(([k, files]) => `${k}(${files.join(", ")})`).join(" / ")}`);

    // 쓸 파일(바뀐 것만)
    const writes: { path: string; text: string }[] = [];
    if (source.config === null || !sameData(source.config, parsedConfig.data)) {
      writes.push({ path: `apps/${app}/app.yaml`, text: yamlText(parsedConfig.data, source.appText, `# ${app} 앱 설정. 타깃별 앱 ID(iOS 번들 ID, Android 패키지)가 플로우의 \${APP_ID} 가 된다.`) });
    }
    if ((source.accountsText === null && Object.keys(nextAccounts).length > 0) || (source.accountsText !== null && !sameData(source.accounts, nextAccounts))) {
      writes.push({ path: `apps/${app}/accounts.yaml`, text: accountsYaml(app, nextAccounts, source.accountsText) });
    }
    if (input.create) {
      if (source.workspaceText === null) throw new WorkspaceError("workspace.yaml 이 없다");
      writes.push({ path: "workspace.yaml", text: addAppToWorkspaceYaml(source.workspaceText, app) });
    }
    if (writes.length === 0) throw new WorkspaceError("바뀐 내용이 없다");
    writes.push(...this.defaultSubflowWrites(app, kinds.filter((target) => !(target in (source.config?.targets ?? {})))));
    await this.refuseLocked(writes.map((w) => w.path));

    const author = await this.authorArgs();
    const { branch } = await this.workBranch(appScope(app), input.summary, "user");
    for (const w of writes) {
      mkdirSync(dirname(join(dir, w.path)), { recursive: true });
      writeFileSync(join(dir, w.path), w.text);
    }
    const paths = writes.map((w) => w.path);
    await this.git(["add", "--", ...paths]);
    if ((await this.git(["diff", "--cached", "--name-only", "--", ...paths])) === "") throw new WorkspaceError("바뀐 내용이 없다");
    await this.git([...author, "commit", "--quiet", "-m", `app: ${app} ${input.summary}`, "--", ...paths]);
    return { status: await this.status(), branch, commit: await this.git(["rev-parse", "--short", "HEAD"]) };
  }

  /**
   * 새로 더한 타깃의 공통 서브플로우 기본 파일(ADR 0036 결정 8). 로컬에서만 만든다: 플로우 만들기가 첫 줄에서 부를 서브플로우가 있어야 한다.
   * GitHub 방식에서는 앱 설정 PR 의 파일 목록이 그대로다. 이미 있는 파일은 덮어쓰지 않는다
   */
  private defaultSubflowWrites(app: string, addedTargets: Target[]): { path: string; text: string }[] {
    if (this.target().kind !== "local") return [];
    const lay = this.layout();
    return addedTargets.flatMap((target) =>
      defaultSubflows(target)
        .map((file) => ({ path: `${lay.commonDir(app, target)}/${file.name}`, text: file.text }))
        .filter((file) => !existsSync(this.insideWorkspace(file.path))),
    );
  }

  /** 편집 기준: 이 앱의 진행 중인 앱 설정 브랜치(있으면)의 파일, 없으면 지금 브랜치의 파일 */
  private async appSource(app: string): Promise<{
    branch: string | null;
    exists: boolean;
    config: AppConfig | null;
    appText: string | null;
    accounts: Accounts;
    accountsText: string | null;
    workspaceText: string | null;
  }> {
    const { branch, ref } = await this.appEditBase(app);
    return { branch, ...(await this.appAt(ref, app)) };
  }

  /** ref(없으면 지금 작업 폴더)의 앱 설정 */
  private async appAt(ref: string | null, app: string): Promise<{
    exists: boolean;
    config: AppConfig | null;
    appText: string | null;
    accounts: Accounts;
    accountsText: string | null;
    workspaceText: string | null;
  }> {
    const workspaceText = await this.readAt(ref, "workspace.yaml");
    const wsConfig = workspaceText ? WorkspaceConfigSchema.safeParse(parseYaml(workspaceText)) : null;
    if (wsConfig && !wsConfig.success) throw new WorkspaceError(`workspace.yaml 형식 오류: ${wsConfig.error.issues.map((i) => i.message).join(" / ")}`);
    const appText = await this.readAt(ref, `apps/${app}/app.yaml`);
    const config = appText ? AppConfigSchema.safeParse(parseYaml(appText)) : null;
    if (config && !config.success) throw new WorkspaceError(`apps/${app}/app.yaml 형식 오류: ${config.error.issues.map((i) => i.message).join(" / ")}`);
    const accountsText = await this.readAt(ref, `apps/${app}/accounts.yaml`);
    const accounts = AccountsSchema.safeParse(accountsText ? (parseYaml(accountsText) ?? {}) : {});
    if (!accounts.success) throw new WorkspaceError(`apps/${app}/accounts.yaml 형식 오류: ${accounts.error.issues.map((i) => i.message).join(" / ")}`);
    return {
      exists: wsConfig?.data.apps.includes(app) ?? false,
      config: config?.data ?? null,
      appText,
      accounts: accounts.data,
      accountsText,
      workspaceText,
    };
  }

  /** 앱 범위(앱 설정·공통 서브플로우)의 편집 기준: 이 앱의 진행 중인 앱 설정 브랜치. 지금 브랜치가 아니면 그 ref 에서 읽는다. 없으면 지금 작업 폴더 */
  private async appEditBase(app: string): Promise<{ branch: string | null; ref: string | null }> {
    const login = await this.whoami();
    const current = await this.currentBranch();
    const scope = appScope(app);
    const branch = workBranchScope(current, login) === scope ? current : await this.scopeBranch(login, scope);
    return { branch, ref: branch && branch !== current ? `refs/heads/${branch}` : null };
  }

  /** 폴더 아래 YAML 파일(워크스페이스 기준 경로). ref 가 있으면 그 브랜치에서, 없으면 지금 작업 폴더에서 찾는다 */
  private async yamlFilesAt(ref: string | null, rel: string): Promise<string[]> {
    if (!ref) return this.flowFiles(rel);
    const out = await this.git(["ls-tree", "-r", "--name-only", ref, "--", `${rel}/`]);
    return out.split("\n").filter((p) => /\.ya?ml$/.test(p));
  }

  /** 앱의 공통 서브플로우와 그것을 부르는 TC 플로우(같은 타깃). 진행 중인 앱 설정 브랜치가 있으면 거기서 읽는다 */
  async subflows(app: string): Promise<SubflowList> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const appId = AppIdSchema.parse(app);
    const { branch, ref } = await this.appEditBase(appId);
    const lay = this.layout();
    const files = await this.yamlFilesAt(ref, lay.flowsDir(appId));
    const flows = files.flatMap((path) => {
      const info = lay.parse(path);
      return info?.kind === "flow" && !info.meta ? [{ path, target: info.target, tcId: info.id }] : [];
    });
    // 플로우마다 runFlow·file 로 부르는 경로(플로우 폴더 기준)
    const calls = new Map<string, Set<string>>();
    for (const f of flows) {
      const text = (await this.readAt(ref, f.path)) ?? "";
      calls.set(f.path, new Set([...text.matchAll(/^\s*(?:-\s*)?(?:runFlow|file):\s*["']?([^"'\s#]+)/gm)].map((m) => m[1] ?? "")));
    }
    const subflows: Subflow[] = [];
    for (const path of files) {
      const info = lay.parse(path);
      if (info?.kind !== "subflow") continue;
      const { target, name } = info;
      const usedBy = flows.filter((f) => f.target === target && calls.get(f.path)?.has(`common/${name}`)).map((f) => f.tcId);
      subflows.push({ target, name, path, text: (await this.readAt(ref, path)) ?? "", usedBy: [...new Set(usedBy)].sort() });
    }
    subflows.sort((a, b) => a.path.localeCompare(b.path));
    return { app: appId, branch, subflows };
  }

  /**
   * 공통 서브플로우 한 개를 고친다. 있는 파일만 고치고(새로 만들거나 지우지 않는다), 서브플로우 규약(lintSubflow)을 통과해야 한다.
   * 그 앱의 앱 설정 작업 브랜치에 그 파일만 커밋한다. 실행·플로우 만들기가 서브플로우를 읽고 있으면 거절한다
   */
  async saveSubflow(input: SaveSubflowInput): Promise<SaveSubflowResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const { app, target, name, summary } = SaveSubflowInputSchema.parse(input);
    const busy = this.options.busy?.();
    if (busy) throw new WorkspaceError(`${busy}. 끝난 뒤 서브플로우를 고친다`);
    const commonDir = this.layout().commonDir(app, target);
    const path = `${commonDir}/${name}`;
    const source = await this.appSource(app);
    if (!source.exists) throw new WorkspaceError(`workspace.yaml 에 없는 앱이다: ${app}`);
    const { ref } = await this.appEditBase(app);
    const before = await this.readAt(ref, path);
    if (before === null) throw new WorkspaceError(`없는 서브플로우다: ${path}`);
    const text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
    if (text === before) throw new WorkspaceError("바뀐 내용이 없다");
    // 서브플로우는 여러 TC 가 같이 부르므로 이 앱 계정 역할의 키를 모두 쓸 수 있다
    const envKeys = [...new Set(Object.values(source.accounts).flatMap((r) => r.keys))];
    const siblings = (await this.yamlFilesAt(ref, commonDir)).map((p) => p.slice(commonDir.length + 1)).filter((n) => n !== name && !n.includes("/"));
    const errors = lintSubflow(text, { envKeys, subflows: siblings }).filter((i) => i.level === "error");
    if (errors.length > 0) throw new WorkspaceError(`서브플로우 규약 오류: ${errors.map((i) => (i.line ? `${i.line}행 ${i.message}` : i.message)).join(" / ")}`);
    await this.refuseLocked([path]);
    // 없는 명령·옵션 이름·값 형식은 Maestro 가 직접 본다. 규약 검사와 둘 다 통과해야 브랜치를 옮긴다
    await this.options.checkFlowSyntax(text);

    const author = await this.authorArgs();
    const { branch } = await this.workBranch(appScope(app), summary, "user");
    const { dir } = this.target();
    // 심볼릭 링크를 따라 워크스페이스 밖에 쓰지 않는다
    const abs = join(dir, path);
    if (!lstatSync(join(dir, commonDir)).isDirectory() || !lstatSync(abs).isFile()) throw new WorkspaceError(`일반 파일이 아니다: ${path}`);
    writeFileSync(abs, text);
    await this.git(["add", "--", path]);
    if ((await this.git(["diff", "--cached", "--name-only", "--", path])) === "") throw new WorkspaceError("바뀐 내용이 없다");
    await this.git([...author, "commit", "--quiet", "-m", `subflow: ${app}/${target} ${name} ${summary}`, "--", path]);
    return { status: await this.status(), branch, commit: await this.git(["rev-parse", "--short", "HEAD"]) };
  }

  /** 브랜치(ref)나 지금 작업 폴더의 파일 내용. 없으면 null */
  private async readAt(ref: string | null, path: string): Promise<string | null> {
    const { dir } = this.target();
    if (!ref) return existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;
    const exists = await this.git(["cat-file", "-e", `${ref}:${path}`]).then(
      () => true,
      () => false,
    );
    return exists ? this.git(["show", `${ref}:${path}`], { raw: true }) : null;
  }

  /** 폴더 아래 YAML 파일(워크스페이스 기준 경로). 심볼릭 링크는 따라가지 않는다 */
  private flowFiles(rel: string): string[] {
    const { dir } = this.target();
    const abs = join(dir, rel);
    if (!existsSync(abs) || !lstatSync(abs).isDirectory()) return [];
    return readdirSync(abs).flatMap((name) => {
      const childRel = `${rel}/${name}`;
      const st = lstatSync(join(dir, childRel));
      if (st.isDirectory()) return this.flowFiles(childRel);
      return st.isFile() && /\.ya?ml$/.test(name) ? [childRel] : [];
    });
  }

  /** 이 앱 플로우(앱의 플로우 폴더 아래 *.yaml)가 \${KEY} 로 쓰는 계정 키와 그 파일. keys 에 있는 것만 본다(APP_ID 같은 다른 값은 뺀다) */
  private flowKeyUses(app: string, keys: Set<string>): Map<string, string[]> {
    const { dir } = this.target();
    const uses = new Map<string, string[]>();
    for (const file of this.flowFiles(this.layout().flowsDir(app))) {
      for (const m of readFileSync(join(dir, file), "utf8").matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) {
        const key = m[1] ?? "";
        if (keys.has(key)) uses.set(key, [...new Set([...(uses.get(key) ?? []), file])]);
      }
    }
    return uses;
  }

  /**
   * 실행할 플로우(워크스페이스 안의 절대 경로). TC 하나 또는 태그로 고른다(PLAN 12장 실행 화면).
   * 태그는 그 앱의 active TC 중 그 타깃 플로우가 있는 것만, TC id 순서로.
   */
  /** 프로젝트 빌드(ADR 0025)에 쓰는 iOS 앱 ID 와 팀 스킴·구성. 지금 브랜치의 app.yaml 에서 읽는다. 연결 전이거나 없으면 null */
  buildHints(app: string): { appId: string | null; scheme: string | null; configuration: string | null } {
    const none = { appId: null, scheme: null, configuration: null };
    if (!this.connected() || !AppIdSchema.safeParse(app).success) return none;
    const ios = loadWorkspace(this.target().dir).apps[app]?.config?.targets.ios;
    return ios ? { appId: ios.appId, scheme: ios.build?.scheme ?? null, configuration: ios.build?.configuration ?? null } : none;
  }

  /**
   * 실행할 플로우를 고른다(ADR 0035 결정 3). 던지지 않고 무엇이 없는지를 돌려준다. 거절 코드는 startRunBatch 가 정한다.
   * - known: 워크스페이스에 있는 앱인가. apps 는 후보로 보인다
   * - missing: tcIds 로 골랐는데 없거나 형식 문제가 있는 TC
   * - noFlow: 골랐지만 이 타깃의 플로우가 없는 TC
   * - envKeys: 그 TC 계정 역할의 키. 실행은 이 키의 계정 값만 Maestro 에 넘긴다
   * 연결 전이면 null
   */
  runPlan(input: { app: string; target: "ios" | "android"; tcIds?: readonly string[]; tag?: string }): {
    known: boolean;
    apps: string[];
    appId: string | null;
    flows: { tcId: string; path: string; envKeys: string[] }[];
    missing: string[];
    noFlow: string[];
  } | null {
    if (!this.connected()) return null;
    const { dir } = this.target();
    const ws = loadWorkspace(dir);
    const apps = ws.config?.apps ?? Object.keys(ws.apps);
    const known = AppIdSchema.safeParse(input.app).success && apps.includes(input.app);
    if (!known) return { known, apps, appId: null, flows: [], missing: [], noFlow: [] };
    // 화면의 TC 목록과 같은 기준: 형식 문제가 있는 TC 는 돌리지 않는다
    const usable = ws.testcases.filter((t) => t.app === input.app && t.doc && !ws.issues.some((i) => i.path === t.path));
    const wanted = input.tcIds ? [...new Set(input.tcIds)] : null;
    const picked = (wanted ? usable.filter((t) => wanted.includes(t.id)) : usable.filter((t) => t.doc?.frontMatter.status === "active" && (t.doc?.frontMatter.tags ?? []).includes(input.tag ?? ""))).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const accounts = ws.apps[input.app]?.accounts ?? {};
    const flows: { tcId: string; path: string; envKeys: string[] }[] = [];
    const noFlow: string[] = [];
    for (const t of picked) {
      const flow = ws.flows.find((f) => f.app === input.app && f.target === input.target && f.tcId === t.id);
      if (flow) flows.push({ tcId: t.id, path: join(dir, flow.path), envKeys: roleKeys(accounts, t.doc?.frontMatter.account) });
      else noFlow.push(t.id);
    }
    const missing = wanted ? wanted.filter((id) => !picked.some((t) => t.id === id)).sort() : [];
    // 빌드 없이(기기에 설치된 앱으로) 돌릴 때 ${APP_ID} 에 넣을 값
    return { known, apps, appId: ws.apps[input.app]?.config?.targets[input.target]?.appId ?? null, flows, missing, noFlow };
  }

  /** 앱 설정에 있는 타깃. 타깃을 주지 않은 실행에서 기기를 고를 때 쓴다. 없는 앱·연결 전이면 [] */
  appTargets(app: string): ("ios" | "android")[] {
    if (!this.connected() || !AppIdSchema.safeParse(app).success) return [];
    const targets = loadWorkspace(this.target().dir).apps[app]?.config?.targets ?? {};
    return (["ios", "android"] as const).filter((t) => t in targets);
  }

  private testcasePath(app: string, id: string): string {
    if (!AppIdSchema.safeParse(app).success || !TC_ID.test(id)) throw new WorkspaceError("앱 id 또는 테스트 케이스 id 형식이 아니다");
    return this.layout().testcasePath(app, id);
  }

  readTestcase(app: string, id: string): { path: string; text: string } {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const path = this.testcasePath(app, id);
    const abs = join(this.target().dir, path);
    if (!existsSync(abs)) throw new WorkspaceError(`테스트 케이스가 없다: ${path}`);
    return { path, text: readFileSync(abs, "utf8") };
  }

  async saveTestcase(input: { app: string; id: string; text: string; summary: string }): Promise<SaveTestcaseResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const path = this.testcasePath(input.app, input.id);
    const { dir } = this.target();
    const ws = loadWorkspace(dir);
    if (!ws.config?.apps.includes(input.app)) throw new WorkspaceError(`workspace.yaml 에 없는 앱이다: ${input.app}`);
    // 검사는 커밋될 브랜치의 앱 설정으로 한다. 작업 폴더가 앱 설정 브랜치이면 main 에서 갈라질 테스트 케이스 브랜치에는 그 앱 설정이 없다
    const base = await this.appAt(await this.workBranchRef(input.id), input.app);
    if (!base.exists) throw new WorkspaceError(await this.unmergedAppSettings(input.app, `${input.app} 앱 설정이 아직 main 에 없다`));
    // 화면과 같은 린트(PLAN 4.2)를 저장할 때 다시 한다. 차단 항목이 있으면 저장하지 않는다
    const lint = lintTestcase(input.text, { accountRoles: Object.keys(base.accounts), appTargets: Object.keys(base.config?.targets ?? {}) }, path);
    if (!lint.doc) throw new WorkspaceError(`테스트 케이스 형식 오류: ${lint.issues.map((i) => i.message).join(" / ")}`);
    if (lint.doc.frontMatter.id !== input.id || lint.doc.frontMatter.app !== input.app) {
      throw new WorkspaceError(`front matter 의 id·app(${lint.doc.frontMatter.id}, ${lint.doc.frontMatter.app})이 저장 위치와 다르다`);
    }
    const here = ws.apps[input.app];
    const baseTargets = base.config?.targets ?? {};
    const unmergedTargets = lint.doc.frontMatter.targets.filter((t) => !(t in baseTargets) && t in (here?.config?.targets ?? {}));
    if (unmergedTargets.length > 0) throw new WorkspaceError(await this.unmergedAppSettings(input.app, `${input.app} 의 ${unmergedTargets.join(", ")} 타깃이 아직 main 의 앱 설정에 없다`));
    const role = lint.doc.frontMatter.account;
    if (role && !(role in base.accounts) && role in (here?.accounts ?? {})) throw new WorkspaceError(await this.unmergedAppSettings(input.app, `${input.app} 의 계정 역할 ${role} 이 아직 main 의 앱 설정에 없다`));
    if (hasBlocking(lint.issues)) {
      throw new WorkspaceError(`테스트 케이스 린트 오류: ${lint.issues.filter((i) => i.level === "error").map((i) => i.message).join(" / ")}`);
    }

    await this.refuseLockedTestcase(input.id, input.app);
    const author = await this.authorArgs();
    const { branch } = await this.workBranch(input.id, input.summary, "user");
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), input.text.endsWith("\n") ? input.text : `${input.text}\n`);
    await this.git(["add", "--", path]);
    if ((await this.git(["diff", "--cached", "--name-only"])) === "") throw new WorkspaceError("바뀐 내용이 없다");
    await this.git([...author, "commit", "--quiet", "-m", `tc: ${input.id} ${input.summary}`]);
    return { status: await this.status(), branch, commit: await this.git(["rev-parse", "--short", "HEAD"]) };
  }

  async authorContext(app: string, id: string, target: "ios" | "android"): Promise<AuthorContext> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const { dir } = this.target();
    const tcPath = this.testcasePath(app, id);
    if (!existsSync(join(dir, tcPath))) throw new WorkspaceError(`테스트 케이스가 없다: ${tcPath}`);
    const ws = loadWorkspace(dir);
    const appInfo = ws.apps[app];
    if (!ws.config?.apps.includes(app) || !appInfo?.config) throw new WorkspaceError(`워크스페이스에 앱 설정이 없다: apps/${app}/app.yaml`);
    const text = readFileSync(join(dir, tcPath), "utf8");
    const lint = lintTestcase(text, { accountRoles: Object.keys(appInfo.accounts), appTargets: Object.keys(appInfo.config.targets) }, tcPath);
    if (!lint.doc || hasBlocking(lint.issues)) {
      throw new WorkspaceError(`테스트 케이스 린트 오류를 먼저 고친다: ${lint.issues.filter((i) => i.level === "error").map((i) => i.message).join(" / ")}`);
    }
    const fm = lint.doc.frontMatter;
    if (!fm.targets.includes(target)) throw new WorkspaceError(`${id} 의 targets 에 ${target} 가 없다`);
    const targetConfig = appInfo.config.targets[target];
    if (!targetConfig) throw new WorkspaceError(`apps/${app}/app.yaml 에 ${target} 타깃이 없다`);
    const envKeys = roleKeys(appInfo.accounts, fm.account);

    const flowDir = ws.layout.flowDir(app, target);
    const commonDir = join(dir, flowDir, "common");
    // 심볼릭 링크는 따라가지 않는다(워크스페이스 밖 파일이 모델에게 가지 않게)
    const subflows =
      existsSync(commonDir) && lstatSync(commonDir).isDirectory()
        ? readdirSync(commonDir)
            .filter((f) => /\.ya?ml$/.test(f) && lstatSync(join(commonDir, f)).isFile())
            .sort()
            .map((f) => ({ path: `common/${f}`, text: readFileSync(join(commonDir, f), "utf8") }))
        : [];
    const dirty = (await this.git(["status", "--porcelain", "--", tcPath])) !== "";
    const last = dirty ? "" : await this.git(["log", "-1", "--format=%h", "--", tcPath]);
    return {
      dir,
      tcPath,
      flowPath: `${flowDir}/${id}.yaml`,
      metaPath: `${flowDir}/${id}.meta.yaml`,
      tc: { id, title: fm.title, markdown: text, steps: lint.doc.steps.length, expectations: lint.doc.steps.reduce((n, st) => n + st.expected.length, 0) },
      envKeys,
      appId: targetConfig.appId,
      locale: appInfo.config.locale ?? ws.config.defaults?.locale ?? null,
      subflows,
      tcVersion: last || "uncommitted",
    };
  }

  /**
   * 재생해 볼 플로우 초안을 제자리(그 TC 의 플로우 경로)에 쓴다. 공통 서브플로우 상대 경로가 그대로 맞는다.
   * 되돌릴 때 쓰도록 이전 내용(없으면 null)을 돌려준다
   */
  writeFlowDraft(flowPath: string, yaml: string): { abs: string; previous: string | null } {
    const abs = this.flowAbs(flowPath);
    const previous = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, yaml.endsWith("\n") ? yaml : `${yaml}\n`);
    return { abs, previous };
  }

  restoreFlowDraft(flowPath: string, previous: string | null): void {
    const abs = this.flowAbs(flowPath);
    if (previous === null) rmSync(abs, { force: true });
    else writeFileSync(abs, previous);
  }

  /** 검증·재생을 통과한 플로우와 meta 를 작업 브랜치에 커밋한다(main 이면 브랜치를 만든다) */
  /**
   * 플로우·meta 를 작업 브랜치에 커밋한다. 같은 내용이 이미 있으면 새로 커밋하지 않고 그 커밋을 돌려준다(unchanged).
   * main 에서 시작했는데 main 과 같으면(이미 승인된 플로우와 같다) 방금 만든 빈 작업 브랜치를 지우고 main 을 돌려준다.
   */
  async saveFlow(input: { id: string; flowPath: string; metaPath: string; yaml: string; meta: string; summary: string }): Promise<{ branch: string; commit: string; unchanged: boolean }> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const { dir } = this.target();
    await this.refuseLockedTestcase(input.id);
    const startBranch = await this.currentBranch();
    // 플로우 만들기가 스스로 부른다(시작할 때 이 TC 의 브랜치나 main 으로 옮겨 두었다)
    const { branch, created } = await this.workBranch(input.id, input.summary, "author-save");
    for (const [path, text] of [
      [input.flowPath, input.yaml],
      [input.metaPath, input.meta],
    ] as const) {
      const abs = this.flowAbs(path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text.endsWith("\n") ? text : `${text}\n`);
    }
    const paths = [input.flowPath, input.metaPath];
    await this.git(["add", "--", ...paths], { cwd: dir });
    if ((await this.git(["diff", "--cached", "--name-only", "--", ...paths])) === "") {
      if (created) {
        // 방금 main 에서 만든 브랜치에 커밋할 것이 없다(main 과 같다): 빈 브랜치를 남기지 않고 원래 브랜치로 돌아간다
        await this.git(["switch", "--quiet", startBranch === "HEAD" ? MAIN : startBranch]);
        await this.git(["branch", "--quiet", "-D", branch]);
        return { branch: MAIN, commit: await this.git(["rev-parse", "--short", MAIN]), unchanged: true };
      }
      return { branch, commit: await this.git(["rev-parse", "--short", "HEAD"]), unchanged: true };
    }
    const author = await this.authorArgs();
    try {
      // 이 두 파일만 커밋한다(다른 스테이지 변경을 끌고 가지 않는다)
      await this.git([...author, "commit", "--quiet", "-m", `flow: ${input.id} ${input.summary}`, "--", ...paths]);
    } catch (error) {
      // 쓴 파일을 커밋 전으로 되돌린다. 남겨 두면 다음 브랜치 바꾸기가 막힌다
      await this.git(["reset", "--quiet", "--", ...paths]).catch(() => undefined);
      const tracked = new Set((await this.git(["ls-tree", "-r", "--name-only", "HEAD", "--", ...paths]).catch(() => "")).split("\n").filter(Boolean));
      for (const path of paths) {
        if (tracked.has(path)) await this.git(["checkout", "--quiet", "HEAD", "--", path]).catch(() => undefined);
        else rmSync(this.flowAbs(path), { force: true });
      }
      throw error;
    }
    return { branch, commit: await this.git(["rev-parse", "--short", "HEAD"]), unchanged: false };
  }

  private flowAbs(flowPath: string): string {
    const info = this.layout().parse(flowPath);
    if (info?.kind !== "flow" || (info.target !== "ios" && info.target !== "android")) throw new WorkspaceError(`플로우 경로 형식이 아니다: ${flowPath}`);
    const abs = this.insideWorkspace(flowPath);
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new WorkspaceError(`심볼릭 링크 파일에는 쓰지 않는다: ${flowPath}`);
    return abs;
  }

  /** 워크스페이스 기준 경로의 절대 경로. 이미 있는 가장 가까운 상위 폴더의 실제 경로가 워크스페이스 안이어야 한다(심볼릭 링크 폴더로 밖에 쓰지 않게) */
  private insideWorkspace(rel: string): string {
    const root = realpathSync(this.target().dir);
    const abs = join(root, rel);
    let dir = dirname(abs);
    while (!existsSync(dir)) dir = dirname(dir);
    const real = realpathSync(dir);
    if (real !== root && !real.startsWith(`${root}${sep}`)) throw new WorkspaceError(`워크스페이스 밖을 가리키는 경로다: ${rel}`);
    return abs;
  }

  /**
   * 이 TC 의 작업 브랜치(TC 하나 = 작업 브랜치 하나 = PR 하나). 다른 TC 의 작업 브랜치에는 섞지 않는다.
   * - 지금 브랜치가 이 TC 의 것이면 그대로 쓴다.
   * - main 에 아직 없는 변경이 남은 이 TC 의 브랜치가 있으면 그리로 옮긴다.
   * - 없으면 main 에서 새로 만든다(main 이면 지금 내용 그대로 브랜치만 만든다).
   * by: user(TC 저장)는 실행·플로우 만들기가 진행 중이면 옮기지 않는다. author-save 는 플로우 만들기 자신의 커밋이다.
   */
  private async workBranch(scope: string, summary: string, by: "user" | "author-save"): Promise<{ branch: string; created: boolean }> {
    if (this.target().kind === "local") {
      // 로컬에는 작업 브랜치와 승인 단계가 없다(ADR 0036 결정 3·4). main 이 아니면 다른 곳에 커밋하지 않고 알린다
      const branch = await this.currentBranch();
      if (branch !== MAIN) throw new WorkspaceError(`로컬 워크스페이스가 main 브랜치가 아니다(${branch}). 로컬 워크스페이스는 main 에만 저장한다`);
      return { branch: MAIN, created: false };
    }
    const login = await this.whoami();
    const current = await this.currentBranch();
    if (workBranchScope(current, login) === scope) return { branch: current, created: false };
    const existing = await this.scopeBranch(login, scope);
    if (existing) {
      await this.switchTo(existing, { by });
      return { branch: existing, created: false };
    }
    // TC 는 qa/<login>/<TC>-<요약>, 앱 설정은 qa/<login>/app/<앱>/<요약>
    const base = scope.startsWith("app/") || scope === WORKSPACE_SCOPE ? `qa/${login}/${scope}/${branchSlug(summary)}` : `qa/${login}/${scope}-${branchSlug(summary)}`;
    const taken = new Set(await this.myBranches(login));
    let branch = base;
    for (let n = 2; taken.has(branch); n += 1) branch = `${base}-${n}`;
    if (current === MAIN) await this.git(["switch", "--quiet", "-c", branch]);
    else await this.switchTo(branch, { by, create: true });
    return { branch, created: true };
  }

  private async currentBranch(): Promise<string> {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** 커밋하지 않은 변경(추적 파일의 변경 + 무시하지 않는 새 파일) */
  private async dirtyFiles(): Promise<string[]> {
    const changed = (await this.git(["diff", "--name-only", "HEAD"])).split("\n");
    const added = (await this.git(["ls-files", "--others", "--exclude-standard"])).split("\n");
    return [...new Set([...changed, ...added].filter(Boolean))];
  }

  /** 내 작업 브랜치 이름(qa/<login>/…, 최근 커밋 순) */
  private async myBranches(login: string): Promise<string[]> {
    const refs = await this.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)", `refs/heads/qa/${login}/`]);
    return refs
      .split("\n")
      .filter(Boolean)
      .map((r) => r.replace(/^refs\/heads\//, ""));
  }

  /** main 에 아직 없는 변경이 있는가. 머지(스쿼시 포함)됐으면 브랜치가 바꾼 파일이 main 과 같다 */
  private async hasPendingWork(branch: string): Promise<boolean> {
    const changed = (await this.git(["diff", "--name-only", `${MAIN}...refs/heads/${branch}`])).split("\n").filter(Boolean);
    if (changed.length === 0) return false;
    return (await this.git(["diff", "--name-only", MAIN, `refs/heads/${branch}`, "--", ...changed])) !== "";
  }

  /** 이 작업 범위(TC 또는 앱 계정 역할)의 내 작업 브랜치 중 main 에 아직 없는 변경이 있는 가장 최근 것 */
  /**
   * 이 범위의 저장이 커밋될 곳. 브랜치를 옮기지 않고 workBranch() 와 같은 규칙으로 본다. null 이면 지금 작업 폴더다
   */
  private async workBranchRef(scope: string): Promise<string | null> {
    if (this.target().kind === "local") return null;
    const login = await this.whoami();
    const current = await this.currentBranch();
    if (workBranchScope(current, login) === scope) return null;
    const existing = await this.scopeBranch(login, scope);
    if (existing) return existing === current ? null : `refs/heads/${existing}`;
    return current === MAIN ? null : `refs/heads/${MAIN}`;
  }

  /** 앱 설정이 아직 머지되지 않아 테스트 케이스를 저장하지 않을 때의 안내. 진행 중인 앱 설정 브랜치가 있으면 이름을 붙인다 */
  private async unmergedAppSettings(app: string, what: string): Promise<string> {
    const pending = await this.scopeBranch(await this.whoami(), appScope(app));
    return `${what}${pending ? `(${pending})` : ""}. 앱 설정 PR 을 머지하고 동기화한 뒤 테스트 케이스를 저장한다`;
  }

  private async scopeBranch(login: string, scope: string): Promise<string | null> {
    for (const name of await this.myBranches(login)) {
      if (workBranchScope(name, login) === scope && (await this.hasPendingWork(name))) return name;
    }
    return null;
  }

  /**
   * 다른 브랜치로 옮긴다(create 면 main 에서 새로 만든다). 워크스페이스 파일이 바뀌므로
   * 저장하지 않은 변경이 있거나, 실행·플로우 만들기가 진행 중이면 옮기지 않는다.
   */
  private async switchTo(branch: string, opts: { by: "user" | "author" | "author-save"; create?: boolean }): Promise<void> {
    if (opts.by !== "author-save") {
      const busy = this.options.busy?.(opts.by === "author" ? "author" : undefined);
      if (busy) throw new WorkspaceError(`${busy}. 끝난 뒤 작업 브랜치를 바꾼다`);
    }
    const dirty = await this.dirtyFiles();
    if (dirty.length > 0) throw new WorkspaceError(`저장하지 않은 변경이 있어 작업 브랜치를 바꾸지 않는다: ${dirty.join(", ")}`);
    await this.git(opts.create ? ["switch", "--quiet", "-c", branch, MAIN] : ["switch", "--quiet", branch]);
  }

  /**
   * 폴더 구조를 앱별(schemaVersion 2)로 바꾼다(ADR 0032): testcases/<앱> → apps/<앱>/testcases, flows/<앱> → apps/<앱>/flows.
   * git mv 로 옮겨 파일 이력이 이어지게 하고, workspace.yaml 의 schemaVersion 과 CODEOWNERS 규칙을 고쳐 작업 브랜치에 한 커밋으로 둔다.
   * 옮기면 다른 작업 브랜치와 충돌하므로, main 에 아직 없는 내 작업 브랜치가 있으면 하지 않는다. 실패하면 옮긴 것을 되돌린다.
   */
  async migrateLayout(): Promise<SaveTestcaseResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    this.requireGithub("폴더 구조 바꾸기");
    if (this.layout().version === 2) throw new WorkspaceError("이미 새 폴더 구조다(schemaVersion 2)");
    const busy = this.options.busy?.();
    if (busy) throw new WorkspaceError(`${busy}. 끝난 뒤 폴더 구조를 바꾼다`);
    const dirty = await this.dirtyFiles();
    if (dirty.length > 0) throw new WorkspaceError(`저장하지 않은 변경이 있어 폴더 구조를 바꾸지 않는다: ${dirty.join(", ")}`);
    if ((await this.currentBranch()) !== MAIN) throw new WorkspaceError("main 에서 바꾼다. 테스트 케이스 화면에서 main 으로 옮긴다");
    const login = await this.whoami();
    const author = await this.authorArgs();
    const pending: string[] = [];
    for (const name of await this.myBranches(login)) if (await this.hasPendingWork(name)) pending.push(name);
    if (pending.length > 0) {
      throw new WorkspaceError(`main 에 아직 없는 작업 브랜치가 있다: ${pending.join(", ")}. PR 을 머지하고 동기화한 뒤 바꾼다(폴더를 옮기면 그 브랜치와 충돌한다)`);
    }

    // 옮길 폴더를 먼저 모두 확인한다(하나라도 막히면 아무것도 옮기지 않는다)
    const { dir } = this.target();
    const moves: { from: string; to: string }[] = [];
    for (const kind of ["testcases", "flows"]) {
      const kindDir = join(dir, kind);
      if (!existsSync(kindDir)) continue;
      for (const name of readdirSync(kindDir).sort()) {
        const st = lstatSync(join(kindDir, name));
        if (!st.isDirectory()) throw new WorkspaceError(`${kind}/ 바로 아래에 폴더가 아닌 것이 있다: ${kind}/${name}. 옮기거나 지운 뒤 바꾼다`);
        if (!AppIdSchema.safeParse(name).success) throw new WorkspaceError(`앱 id 형식이 아닌 폴더가 있다: ${kind}/${name}. 이름을 고치거나 지운 뒤 바꾼다`);
        const to = `apps/${name}/${kind}`;
        if (existsSync(join(dir, to))) throw new WorkspaceError(`옮길 자리에 이미 있다: ${to}`);
        moves.push({ from: `${kind}/${name}`, to });
      }
    }

    const { branch } = await this.workBranch(WORKSPACE_SCOPE, "layout v2", "user");
    const done: { from: string; to: string; tracked: boolean }[] = [];
    const touched = ["workspace.yaml"];
    try {
      for (const move of moves) {
        mkdirSync(dirname(join(dir, move.to)), { recursive: true });
        // 추적하는 파일이 없는 폴더는 git mv 가 옮기지 못한다
        const tracked = (await this.git(["ls-files", "--", move.from])) !== "";
        if (tracked) await this.git(["mv", "--", move.from, move.to]);
        else renameSync(join(dir, move.from), join(dir, move.to));
        done.push({ ...move, tracked });
      }
      for (const kind of ["testcases", "flows"]) {
        if (existsSync(join(dir, kind))) rmdirSync(join(dir, kind));
      }
      const doc = parseDocument(readFileSync(join(dir, "workspace.yaml"), "utf8"));
      doc.set("schemaVersion", 2);
      writeFileSync(join(dir, "workspace.yaml"), doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
      // 승인 권한자 규칙도 새 경로를 가리키게 한다
      const owners = join(dir, "CODEOWNERS");
      if (existsSync(owners) && lstatSync(owners).isFile()) {
        const before = readFileSync(owners, "utf8");
        const after = before.replace(/^(#\s*예:\s*)?\/(flows|testcases)\//gm, "$1/apps/*/$2/");
        if (after !== before) {
          writeFileSync(owners, after);
          touched.push("CODEOWNERS");
        }
      }
      await this.git(["add", "--", ...touched]);
      await this.git([...author, "commit", "--quiet", "-m", "workspace: 폴더를 앱별로 모은다(schemaVersion 2)"]);
    } catch (error) {
      // 옮긴 것을 거꾸로 되돌리고, 방금 만든 브랜치를 지운다
      for (const move of done.reverse()) {
        mkdirSync(dirname(join(dir, move.from)), { recursive: true });
        if (move.tracked) await this.git(["mv", "--", move.to, move.from]).catch(() => undefined);
        else if (existsSync(join(dir, move.to))) renameSync(join(dir, move.to), join(dir, move.from));
      }
      await this.git(["reset", "--quiet", "--", ...touched]).catch(() => undefined);
      await this.git(["checkout", "--quiet", "HEAD", "--", ...touched]).catch(() => undefined);
      await this.git(["switch", "--quiet", MAIN]).catch(() => undefined);
      await this.git(["branch", "--quiet", "-D", branch]).catch(() => undefined);
      throw error;
    }
    return { status: await this.status(), branch, commit: await this.git(["rev-parse", "--short", "HEAD"]) };
  }

  /**
   * 머지 전인 내 가져오기 브랜치가 바꾼 파일(경로 → 브랜치). GitHub 방식에서만 있다.
   * 그 PR 이 머지되기 전에 가져온 항목을 고치면 main 에서 갈라진 브랜치에 가져온 앱 설정이 없어 깨진다(ADR 0036 결정 11).
   * workspace.yaml 은 항목이 아니라 넣지 않는다(다른 새 앱 등록은 막지 않는다).
   * 이 Mac 의 로컬 브랜치만 본다(가져오기 브랜치는 이 Mac 에서만 만든다). 그래서 GitHub 로그인을 묻지 않는다
   */
  private async importLocks(): Promise<Map<string, string>> {
    const locks = new Map<string, string>();
    if (this.target().kind !== "github") return locks;
    const refs = await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads/qa/"]);
    for (const name of refs.split("\n").filter((r) => /^qa\/[^/]+\/import\//.test(r))) {
      if (!(await this.hasPendingWork(name))) continue;
      for (const path of (await this.git(["diff", "--name-only", `${MAIN}...refs/heads/${name}`])).split("\n")) {
        if (path && path !== "workspace.yaml" && !locks.has(path)) locks.set(path, name);
      }
    }
    return locks;
  }

  /** 잠긴 경로 가운데 조건에 맞는 첫 것의 브랜치 */
  private lockFor(locks: Map<string, string>, lay: WorkspaceLayout, match: (info: NonNullable<ReturnType<WorkspaceLayout["parse"]>>) => boolean): { branch: string } | null {
    for (const [path, branch] of locks) {
      const info = lay.parse(path);
      if (info && match(info)) return { branch };
    }
    return null;
  }

  /** 테스트 케이스는 파일(.md·플로우·meta) 하나라도 잠겼으면 통째로 잠긴 것으로 본다(화면의 lockedBy 와 같은 기준) */
  private async refuseLockedTestcase(id: string, app?: string): Promise<void> {
    const locked = this.lockFor(await this.importLocks(), this.layout(), (info) => (info.kind === "testcase" || info.kind === "flow") && info.id === id && (app === undefined || info.app === app));
    if (locked) throw new WorkspaceError(`${id} 는 가져오기 브랜치 ${locked.branch} 가 바꿨다. 가져오기 PR 을 머지하고 동기화한 뒤 고친다`);
  }

  private async refuseLocked(paths: readonly string[]): Promise<void> {
    const locks = await this.importLocks();
    for (const path of paths) {
      const branch = locks.get(path);
      if (branch) throw new WorkspaceError(`${path} 는 가져오기 브랜치 ${branch} 가 바꿨다. 가져오기 PR 을 머지하고 동기화한 뒤 고친다`);
    }
  }

  /** 내보낼 ref: 로컬은 HEAD(저장마다 커밋한다), GitHub 방식은 main(작업 브랜치의 승인 전 수정이 섞이지 않게) */
  private exportRef(): "HEAD" | "main" {
    return this.target().kind === "local" ? "HEAD" : MAIN;
  }

  /** 내보낼 내용(ADR 0036 결정 11). 넣는 경로는 workspace.yaml 과 apps/ 뿐이다 */
  async exportInfo(): Promise<ExportInfo> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const ref = this.exportRef();
    const wsText = await this.readAt(ref, "workspace.yaml");
    if (wsText === null) throw new WorkspaceError(`${ref} 에 workspace.yaml 이 없다`);
    let schemaVersion: unknown;
    try {
      const raw: unknown = parseYaml(wsText);
      schemaVersion = raw !== null && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
    } catch (error) {
      throw new WorkspaceError(`workspace.yaml YAML 오류: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lay = layoutForSchemaVersion(schemaVersion);
    if (lay.version !== 2) throw new WorkspaceError("예전 폴더 구조(schemaVersion 1)는 내보내지 않는다. 워크스페이스 화면에서 폴더 구조를 먼저 바꾼다");
    const paths = (await this.git(["ls-tree", "-r", "--name-only", "-z", ref, "--", "apps"], { raw: true })).split("\0").filter(Boolean);
    const apps = paths.flatMap((p) => /^apps\/([^/]+)\/app\.yaml$/.exec(p)?.[1] ?? []).sort();
    const appNames: string[] = [];
    for (const app of apps) {
      const parsed = AppConfigSchema.safeParse(parseYaml((await this.readAt(ref, `apps/${app}/app.yaml`)) ?? ""));
      appNames.push(parsed.success ? parsed.data.name : app);
    }
    const infos = paths.map((p) => lay.parse(p));
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return {
      apps: apps.length,
      testcases: infos.filter((i) => i?.kind === "testcase").length,
      flows: infos.filter((i) => i?.kind === "flow" && !i.meta).length,
      subflows: infos.filter((i) => i?.kind === "subflow").length,
      ref,
      fileName: `avocado-workspace-${day}.zip`,
      appNames,
      testcaseIds: infos.flatMap((i) => (i?.kind === "testcase" ? [i.id] : [])).sort(),
    };
  }

  /** main 이 연 저장 창에서 고른 곳에 zip 을 쓴다(git archive). 옆의 임시 파일에 만든 뒤 이름을 바꿔 반쯤 쓴 zip 이 남지 않게 한다 */
  async exportZip(): Promise<ExportResult> {
    const info = await this.exportInfo();
    if (!this.options.pickExportPath) throw new WorkspaceError("저장 창을 열 수 없다");
    const dest = await this.options.pickExportPath(info.fileName);
    if (!dest) return null;
    const tmp = `${dest}.avocado-${randomUUID()}.tmp`;
    try {
      // 앱이 없는 워크스페이스에는 apps/ 가 없고, 없는 경로를 주면 git archive 가 실패한다
      const hasApps = (await this.git(["ls-tree", "--name-only", info.ref, "--", "apps"])) !== "";
      await this.git(["archive", "--format=zip", `--output=${tmp}`, info.ref, "--", "workspace.yaml", ...(hasApps ? ["apps"] : [])]);
      renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
    return { path: displayPath(dest, this.options.home ?? homedir()) };
  }

  /** GitHub 방식에서 가져오기의 기준인 main 이 원격보다 뒤처져 있으면 거절한다(동기화한 main 위에 가져온다) */
  private async requireMainCurrent(): Promise<void> {
    const hasOrigin = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${MAIN}`]).then(
      () => true,
      () => false,
    );
    if (!hasOrigin) return;
    const behind = Number(await this.git(["rev-list", "--count", `refs/heads/${MAIN}..refs/remotes/origin/${MAIN}`]));
    if (behind > 0) throw new WorkspaceError(`main 이 원격보다 ${behind}개 뒤처져 있다. main 으로 옮겨 동기화한 뒤 가져온다`);
  }

  /**
   * 가져올 곳을 읽고 받는 쪽과 견준다(ADR 0036 결정 11). zip·폴더는 main 이 연 창에서 고르고, 이 Mac 의 로컬 워크스페이스는 GitHub 방식에서만 고른다.
   * 하나라도 걸리면 묶음 전체를 거절하고 아무것도 쓰지 않는다. 미리보기의 바이트는 이 서비스에만 둔다
   */
  async importPick(from: ImportSource): Promise<ImportPickResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const target = this.target();
    let label: string;
    let read: ArchiveRead;
    if (from === "local-workspace") {
      if (target.kind !== "github") throw new WorkspaceError(`${LOCAL_WORKSPACE_LABEL}에서 가져오기: GitHub 사용을 켠 워크스페이스에서만 쓴다`);
      const localDir = this.options.localDir;
      if (!existsSync(join(localDir, ".git"))) throw new WorkspaceError(`${LOCAL_WORKSPACE_LABEL}가 없다`);
      label = LOCAL_WORKSPACE_LABEL;
      // 앱이 만든 local-workspace 만 git 으로 읽는다(사람이 고른 폴더에서는 git 을 실행하지 않는다)
      read = await readTree(
        (args, opts) => this.git(args, { ...opts, cwd: localDir }),
        (args, opts) => this.gitBytes(args, { ...opts, cwd: localDir }),
        "HEAD",
        { hostile: true },
      );
    } else {
      if (!this.options.pickImport) throw new WorkspaceError("가져올 곳을 고를 창을 열 수 없다");
      const picked = await this.options.pickImport(from);
      if (!picked) return { status: "canceled" };
      label = basename(picked);
      read = from === "file" ? readZipFile(picked) : readFolder(picked);
    }
    if (!read.ok) return { status: "rejected", sourceLabel: label, problems: read.problems };
    if (target.kind === "github") await this.requireMainCurrent();
    const ref = target.kind === "local" ? "HEAD" : `refs/heads/${MAIN}`;
    const base = await this.git(["rev-parse", ref]);
    const receiving = await readTree(
      (args, opts) => this.git(args, opts),
      (args, opts) => this.gitBytes(args, opts),
      ref,
      { hostile: false },
    );
    if (!receiving.ok) throw new WorkspaceError("이 워크스페이스를 읽지 못했다");
    let result;
    try {
      result = await planImport({ incoming: read.files, receiving: receiving.files, checks: { checkFlowSyntax: this.options.checkFlowSyntax } });
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(error instanceof Error ? error.message : String(error));
    }
    if (!result.ok) return { status: "rejected", sourceLabel: label, problems: result.problems };
    const id = randomUUID();
    this.pendingImport = { id, kind: target.kind, dir: target.dir, base, label, plan: result.plan };
    return { status: "preview", preview: { importId: id, sourceLabel: label, items: result.plan.items, skipped: result.plan.skipped, summary: result.plan.summary } };
  }

  /**
   * 미리보기에서 고른 항목을 쓴다. 실행·플로우 만들기 중이거나 미리보기 뒤 워크스페이스가 바뀌었으면 거절한다.
   * 로컬은 main 에 한 커밋, GitHub 방식은 새 가져오기 브랜치에 한 커밋(작업 폴더와 지금 브랜치는 그대로)
   */
  async importApply(input: ImportApplyInput): Promise<ImportApplyResult> {
    const pending = this.pendingImport;
    if (!pending || pending.id !== input.importId) throw new WorkspaceError("가져오기 미리보기가 없다. 다시 고른다");
    const busy = this.options.busy?.();
    if (busy) throw new WorkspaceError(`${busy}. 끝난 뒤 가져온다`);
    const target = this.target();
    if (target.kind !== pending.kind || target.dir !== pending.dir) throw new WorkspaceError("미리보기를 만든 뒤 워크스페이스 출처가 바뀌었다. 다시 고른다");
    if (target.kind === "github") await this.requireMainCurrent();
    const ref = target.kind === "local" ? "HEAD" : `refs/heads/${MAIN}`;
    if ((await this.git(["rev-parse", ref])) !== pending.base) throw new WorkspaceError("미리보기를 만든 뒤 워크스페이스가 바뀌었다. 다시 고른다");
    let writes;
    try {
      writes = pending.plan.apply(input.picks);
    } catch (error) {
      if (error instanceof ImportPickError) throw new WorkspaceError(error.message);
      throw error;
    }
    const counts = (Object.keys(IMPORT_KIND_LABEL) as TransferItemKind[])
      .map((kind) => [kind, writes.picked.filter((p) => p.item.kind === kind && p.action !== "keep-ours").length] as const)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${IMPORT_KIND_LABEL[kind]} ${n}`);
    const message = `import: ${pending.label}에서 가져온다(${counts.join(", ")})`;
    const author = await this.authorArgs();
    if (target.kind === "local") {
      if ((await this.currentBranch()) !== MAIN) throw new WorkspaceError("로컬 워크스페이스가 main 브랜치가 아니다. 로컬 워크스페이스는 main 에만 저장한다");
      const commit = await commitLocalImport({ git: (args, opts) => this.git(args, opts), files: writes.files, message, author, resolve: (rel) => this.insideWorkspace(rel) });
      this.pendingImport = null;
      return { source: "local", commit, renumbered: writes.renumbered };
    }
    const login = await this.whoami();
    const apps = [...new Set(writes.picked.map((p) => p.item.app))].sort();
    const { branch, commit } = await commitImportBranch({ git: (args, opts) => this.git(args, opts), branchBase: `qa/${login}/${IMPORT_SCOPE}${branchSlug(apps.join(" "))}`, files: writes.files, message, author });
    this.pendingImport = null;
    return { source: "github", branch: WorkBranchNameSchema.parse(branch), commit, renumbered: writes.renumbered };
  }

  importCancel(importId: string): { canceled: true } {
    if (this.pendingImport?.id === importId) this.pendingImport = null;
    return { canceled: true };
  }

  async history(app: string, id: string): Promise<TestcaseHistory> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const path = this.testcasePath(app, id);
    const out = await this.git(["log", "-n", "20", "--follow", "--format=%h%x1f%aI%x1f%an%x1f%s", "--", path]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit = "", date = "", author = "", subject = ""] = line.split("\x1f");
        return { commit, date, author, subject };
      });
  }

  /** 워크스페이스 저장소의 내 열린 PR(홈 화면) */
  async myPullRequests(): Promise<{ number: number; title: string; url: string; branch: string; createdAt: string }[]> {
    const source = this.target();
    // 로컬에는 PR 이 없다. 홈 화면이 늘 읽는 목록이라 거절하지 않고 빈 목록을 준다
    if (source.kind === "local") return [];
    const { owner, repo } = source;
    const login = await this.whoami();
    const pulls = await this.options.remote.listOpenPullRequests({ owner, repo });
    return pulls.filter((p) => p.author === login).map(({ number, title, url, branch, createdAt }) => ({ number, title, url, branch, createdAt }));
  }

  /** 작업 브랜치를 푸시하고 PR 을 만든다. main 에서는 하지 않는다 */
  /**
   * 작업 브랜치(없으면 지금 브랜치)를 푸시하고 PR 을 만든다. 브랜치를 바꾸지 않고 그 브랜치를 올린다.
   * 이 브랜치의 열린 PR 이 이미 있으면 새 커밋만 올리고 그 PR 을 돌려준다(TC 하나에 PR 하나).
   */
  async requestReview(input: { title: string; body: string; branch?: string | undefined }): Promise<RequestReviewResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const { owner, repo } = this.requireGithub("PR 작성");
    const current = await this.currentBranch();
    const branch = input.branch ?? current;
    if (branch === MAIN || branch === "HEAD") throw new WorkspaceError("main 에서는 PR 을 만들지 않는다. 테스트 케이스를 저장하면 작업 브랜치가 생긴다");
    const login = await this.whoami();
    if (!(await this.myBranches(login)).includes(branch)) throw new WorkspaceError(`내 작업 브랜치가 아니다: ${branch}`);
    if (branch === current) {
      const dirty = await this.dirtyFiles();
      if (dirty.length > 0) throw new WorkspaceError(`저장하지 않은 변경이 있다: ${dirty.join(", ")}`);
    }
    if ((await this.git(["rev-list", "--count", `${MAIN}..refs/heads/${branch}`])) === "0") throw new WorkspaceError(`${branch} 에 main 보다 앞선 커밋이 없다`);
    await this.git(["push", "--quiet", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { auth: true });
    const open = (await this.options.remote.listOpenPullRequests({ owner, repo })).find((p) => p.branch === branch && p.author === login);
    if (open) return { number: open.number, url: open.url, branch, existing: true };
    const pr = await this.options.remote.createPullRequest({ repo: { owner, repo }, head: branch, base: MAIN, title: input.title, body: input.body });
    return { ...pr, branch, existing: false };
  }

  /** 내 작업 브랜치 목록(최근 커밋 순). 다른 TC 의 브랜치로 체크아웃하거나 PR 을 만들 때 쓴다 */
  async branches(): Promise<WorkBranchList> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const login = await this.whoami();
    const current = await this.currentBranch();
    const branches: WorkBranch[] = [];
    for (const name of await this.myBranches(login)) {
      const scope = workBranchScope(name, login);
      branches.push({
        name,
        tcId: workBranchTc(name, login),
        appSettings: scope?.startsWith("app/") ? scope.slice("app/".length) : null,
        current: name === current,
        ahead: Number(await this.git(["rev-list", "--count", `${MAIN}..refs/heads/${name}`])),
        subject: await this.git(["log", "-1", "--format=%s", `refs/heads/${name}`]),
        pending: await this.hasPendingWork(name),
      });
    }
    return { current, branches };
  }

  /** main 이나 내 작업 브랜치로 바꾼다(화면에서 다른 TC 의 작업을 볼 때) */
  async checkout(branch: string): Promise<WorkspaceStatus> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    if (branch !== MAIN) {
      this.requireGithub("작업 브랜치로 바꾸기");
      if (!(await this.myBranches(await this.whoami())).includes(branch)) throw new WorkspaceError(`내 작업 브랜치가 아니다: ${branch}`);
    }
    if (branch !== (await this.currentBranch())) await this.switchTo(branch, { by: "user" });
    return this.status();
  }

  /**
   * 플로우 만들기를 시작할 때: 이 TC 의 작업 브랜치로, 없으면 main 으로 옮긴다.
   * 다른 TC 의 작업 브랜치에서 TC 를 읽고 재생하고 커밋하지 않게 한다.
   */
  async useTestcaseBranch(id: string): Promise<string> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    await this.refuseLockedTestcase(id);
    const login = await this.whoami();
    const current = await this.currentBranch();
    if (workBranchTc(current, login) === id) return current;
    const target = (await this.scopeBranch(login, id)) ?? MAIN;
    if (target !== current) await this.switchTo(target, { by: "author" });
    return target;
  }
}
