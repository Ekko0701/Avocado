import type { GitHubSettings, RequestReviewResult, SaveTestcaseResult, TestcaseHistory, TestcaseList, WorkBranch, WorkBranchList, WorkspaceAccounts, WorkspaceStatus } from "@qa/shared";
import { AppIdSchema } from "@qa/shared";
import { runGit, type AskpassServer, type RemoteProvider } from "@qa/remote";
import { hasBlocking, lintTestcase, loadWorkspace, TC_ID } from "@qa/workspace";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceServiceOptions {
  /** userData/workspaces */
  root: string;
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
}

const MAIN = "main";

/** qa/<login>/<TC-id>-… 작업 브랜치의 TC id. 내 작업 브랜치가 아니면 null */
export function workBranchTc(branch: string, login: string): string | null {
  const prefix = `qa/${login}/`;
  if (!branch.startsWith(prefix)) return null;
  return /^(TC-\d{4,})(?:-|$)/.exec(branch.slice(prefix.length))?.[1] ?? null;
}

/** 플로우 만들기 입력(PLAN 6.5 1) */
export interface AuthorContext {
  /** 워크스페이스 clone 폴더 */
  dir: string;
  tcPath: string;
  /** 워크스페이스 기준 flows/<app>/<target>/<TC>.yaml */
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

  constructor(private readonly options: WorkspaceServiceOptions) {}

  private target(): { owner: string; repo: string; dir: string } {
    const g = this.options.github();
    if (!g.owner) throw new WorkspaceError("GitHub 조직 이름을 먼저 설정한다");
    return { owner: g.owner, repo: g.workspaceRepo, dir: join(this.options.root, g.workspaceRepo) };
  }

  private async git(args: string[], opts: { auth?: boolean; cwd?: string } = {}): Promise<string> {
    const token = this.options.token();
    let session: ReturnType<AskpassServer["session"]> | undefined;
    if (opts.auth) {
      if (!token) throw new WorkspaceError("GitHub 토큰이 없다. 설정에서 저장한다");
      session = (await this.options.askpass()).session({ username: "x-access-token", password: token });
    }
    try {
      const r = await runGit(args, { cwd: opts.cwd ?? this.target().dir, askpass: session, secrets: token ? [token] : [], home: this.options.home, timeoutMs: 180_000 });
      if (r.code !== 0) throw new WorkspaceError(`git ${args[0] ?? ""} 실패: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return r.stdout.trim();
    } finally {
      session?.dispose();
    }
  }

  private async whoami(): Promise<string> {
    const token = this.options.token() ?? "";
    if (!this.login || this.login.token !== token) this.login = { token, login: (await this.options.remote.verify([])).login };
    return this.login.login;
  }

  private connected(): boolean {
    const g = this.options.github();
    return g.owner !== null && existsSync(join(this.options.root, g.workspaceRepo, ".git"));
  }

  async status(): Promise<WorkspaceStatus> {
    const g = this.options.github();
    const repo = g.owner ? `${g.owner}/${g.workspaceRepo}` : null;
    if (!this.connected()) return { connected: false, repo, branch: null, head: null, onMain: false, dirty: [], ahead: 0, behind: 0, issues: 0 };
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
    return { connected: true, repo, branch, head, onMain: branch === MAIN, dirty, ahead, behind, issues: loadWorkspace(this.target().dir).issues.length };
  }

  /** 처음이면 clone 한다. 이미 있으면 그대로 둔다 */
  async connect(): Promise<WorkspaceStatus> {
    const { owner, repo, dir } = this.target();
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
    await this.git(["fetch", "--quiet", "--prune", "origin"], { auth: true });
    const s = await this.status();
    if (s.onMain && s.dirty.length === 0 && s.behind > 0) await this.git(["merge", "--ff-only", "--quiet", `origin/${MAIN}`]);
    return this.status();
  }

  testcases(): TestcaseList {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const ws = loadWorkspace(this.target().dir);
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

  /**
   * 실행할 플로우(워크스페이스 안의 절대 경로). TC 하나 또는 태그로 고른다(PLAN 12장 실행 화면).
   * 태그는 그 앱의 active TC 중 그 타깃 플로우가 있는 것만, TC id 순서로.
   */
  flowsToRun(input: { app: string; target: "ios" | "android"; tcId?: string; tag?: string }): { appId: string | null; flows: { tcId: string; path: string }[] } {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    if (!AppIdSchema.safeParse(input.app).success) throw new WorkspaceError("앱 id 형식이 아니다");
    const { dir } = this.target();
    const ws = loadWorkspace(dir);
    // 화면의 TC 목록과 같은 기준: 형식 문제가 있는 TC 는 돌리지 않는다
    const picked = ws.testcases
      .filter((t) => t.app === input.app && t.doc && !ws.issues.some((i) => i.path === t.path))
      .filter((t) => (input.tcId ? t.id === input.tcId : t.doc?.frontMatter.status === "active" && (t.doc?.frontMatter.tags ?? []).includes(input.tag ?? "")))
      .sort((a, b) => a.id.localeCompare(b.id));
    const out: { tcId: string; path: string }[] = [];
    for (const t of picked) {
      const flow = ws.flows.find((f) => f.app === input.app && f.target === input.target && f.tcId === t.id);
      if (flow) out.push({ tcId: t.id, path: join(dir, flow.path) });
    }
    if (input.tcId && out.length === 0) throw new WorkspaceError(`${input.tcId} 의 ${input.target} 플로우가 없다(flows/${input.app}/${input.target}/${input.tcId}.yaml)`);
    if (!input.tcId && out.length === 0) throw new WorkspaceError(`태그 ${input.tag ?? ""} 인 active TC 중 ${input.target} 플로우가 있는 것이 없다`);
    // 빌드 없이(기기에 설치된 앱으로) 돌릴 때 ${APP_ID} 에 넣을 값
    return { appId: ws.apps[input.app]?.config?.targets[input.target]?.appId ?? null, flows: out };
  }

  private testcasePath(app: string, id: string): string {
    if (!AppIdSchema.safeParse(app).success || !TC_ID.test(id)) throw new WorkspaceError("앱 id 또는 TC id 형식이 아니다");
    return `testcases/${app}/${id}.md`;
  }

  readTestcase(app: string, id: string): { path: string; text: string } {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const path = this.testcasePath(app, id);
    const abs = join(this.target().dir, path);
    if (!existsSync(abs)) throw new WorkspaceError(`TC 가 없다: ${path}`);
    return { path, text: readFileSync(abs, "utf8") };
  }

  async saveTestcase(input: { app: string; id: string; text: string; summary: string }): Promise<SaveTestcaseResult> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const path = this.testcasePath(input.app, input.id);
    const { dir } = this.target();
    const ws = loadWorkspace(dir);
    if (!ws.config?.apps.includes(input.app)) throw new WorkspaceError(`workspace.yaml 에 없는 앱이다: ${input.app}`);
    // 화면과 같은 린트(PLAN 4.2)를 저장할 때 다시 한다. 차단 항목이 있으면 저장하지 않는다
    const appInfo = ws.apps[input.app];
    const lint = lintTestcase(input.text, { accountRoles: Object.keys(appInfo?.accounts ?? {}), appTargets: Object.keys(appInfo?.config?.targets ?? {}) }, path);
    if (!lint.doc) throw new WorkspaceError(`TC 형식 오류: ${lint.issues.map((i) => i.message).join(" / ")}`);
    if (lint.doc.frontMatter.id !== input.id || lint.doc.frontMatter.app !== input.app) {
      throw new WorkspaceError(`front matter 의 id·app(${lint.doc.frontMatter.id}, ${lint.doc.frontMatter.app})이 저장 위치와 다르다`);
    }
    if (hasBlocking(lint.issues)) {
      throw new WorkspaceError(`TC 린트 오류: ${lint.issues.filter((i) => i.level === "error").map((i) => i.message).join(" / ")}`);
    }

    const login = await this.whoami();
    const { branch } = await this.workBranch(input.id, input.summary, "user");
    mkdirSync(join(dir, "testcases", input.app), { recursive: true });
    writeFileSync(join(dir, path), input.text.endsWith("\n") ? input.text : `${input.text}\n`);
    await this.git(["add", "--", path]);
    if ((await this.git(["diff", "--cached", "--name-only"])) === "") throw new WorkspaceError("바뀐 내용이 없다");
    await this.git(["-c", `user.name=${login}`, "-c", `user.email=${login}@users.noreply.github.com`, "commit", "--quiet", "-m", `tc: ${input.id} ${input.summary}`]);
    return { status: await this.status(), branch, commit: await this.git(["rev-parse", "--short", "HEAD"]) };
  }

  async authorContext(app: string, id: string, target: "ios" | "android"): Promise<AuthorContext> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const { dir } = this.target();
    const tcPath = this.testcasePath(app, id);
    if (!existsSync(join(dir, tcPath))) throw new WorkspaceError(`TC 가 없다: ${tcPath}`);
    const ws = loadWorkspace(dir);
    const appInfo = ws.apps[app];
    if (!ws.config?.apps.includes(app) || !appInfo?.config) throw new WorkspaceError(`워크스페이스에 앱 설정이 없다: apps/${app}/app.yaml`);
    const text = readFileSync(join(dir, tcPath), "utf8");
    const lint = lintTestcase(text, { accountRoles: Object.keys(appInfo.accounts), appTargets: Object.keys(appInfo.config.targets) }, tcPath);
    if (!lint.doc || hasBlocking(lint.issues)) {
      throw new WorkspaceError(`TC 린트 오류를 먼저 고친다: ${lint.issues.filter((i) => i.level === "error").map((i) => i.message).join(" / ")}`);
    }
    const fm = lint.doc.frontMatter;
    if (!fm.targets.includes(target)) throw new WorkspaceError(`${id} 의 targets 에 ${target} 가 없다`);
    const targetConfig = appInfo.config.targets[target];
    if (!targetConfig) throw new WorkspaceError(`apps/${app}/app.yaml 에 ${target} 타깃이 없다`);
    const role = fm.account;
    const envKeys = role ? [...(appInfo.accounts[role]?.keys ?? [])] : [];

    const flowDir = `flows/${app}/${target}`;
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
   * 재생해 볼 플로우 초안을 제자리(flows/<app>/<target>/<TC>.yaml)에 쓴다. 공통 서브플로우 상대 경로가 그대로 맞는다.
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
    const login = await this.whoami();
    try {
      // 이 두 파일만 커밋한다(다른 스테이지 변경을 끌고 가지 않는다)
      await this.git(["-c", `user.name=${login}`, "-c", `user.email=${login}@users.noreply.github.com`, "commit", "--quiet", "-m", `flow: ${input.id} ${input.summary}`, "--", ...paths]);
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
    if (!/^flows\/[a-z0-9][a-z0-9-]{0,39}\/(ios|android)\/TC-\d{4,}(\.meta)?\.yaml$/.test(flowPath)) throw new WorkspaceError(`플로우 경로 형식이 아니다: ${flowPath}`);
    const root = realpathSync(this.target().dir);
    const abs = join(root, flowPath);
    // 이미 있는 가장 가까운 상위 폴더의 실제 경로가 워크스페이스 안이어야 한다(심볼릭 링크 폴더로 밖에 쓰지 않게)
    let dir = dirname(abs);
    while (!existsSync(dir)) dir = dirname(dir);
    const real = realpathSync(dir);
    if (real !== root && !real.startsWith(`${root}${sep}`)) throw new WorkspaceError(`워크스페이스 밖을 가리키는 경로다: ${flowPath}`);
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new WorkspaceError(`심볼릭 링크 파일에는 쓰지 않는다: ${flowPath}`);
    return abs;
  }

  /**
   * 이 TC 의 작업 브랜치(TC 하나 = 작업 브랜치 하나 = PR 하나). 다른 TC 의 작업 브랜치에는 섞지 않는다.
   * - 지금 브랜치가 이 TC 의 것이면 그대로 쓴다.
   * - main 에 아직 없는 변경이 남은 이 TC 의 브랜치가 있으면 그리로 옮긴다.
   * - 없으면 main 에서 새로 만든다(main 이면 지금 내용 그대로 브랜치만 만든다).
   * by: user(TC 저장)는 실행·플로우 만들기가 진행 중이면 옮기지 않는다. author-save 는 플로우 만들기 자신의 커밋이다.
   */
  private async workBranch(id: string, summary: string, by: "user" | "author-save"): Promise<{ branch: string; created: boolean }> {
    const login = await this.whoami();
    const current = await this.currentBranch();
    if (workBranchTc(current, login) === id) return { branch: current, created: false };
    const existing = await this.tcBranch(login, id);
    if (existing) {
      await this.switchTo(existing, { by });
      return { branch: existing, created: false };
    }
    const base = `qa/${login}/${id}-${branchSlug(summary)}`;
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

  /** 이 TC 의 내 작업 브랜치 중 main 에 아직 없는 변경이 있는 가장 최근 것 */
  private async tcBranch(login: string, id: string): Promise<string | null> {
    for (const name of await this.myBranches(login)) {
      if (workBranchTc(name, login) === id && (await this.hasPendingWork(name))) return name;
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
    const { owner, repo } = this.target();
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
    const current = await this.currentBranch();
    const branch = input.branch ?? current;
    if (branch === MAIN || branch === "HEAD") throw new WorkspaceError("main 에서는 검토 요청을 하지 않는다. TC 를 저장하면 작업 브랜치가 생긴다");
    const login = await this.whoami();
    if (!(await this.myBranches(login)).includes(branch)) throw new WorkspaceError(`내 작업 브랜치가 아니다: ${branch}`);
    if (branch === current) {
      const dirty = await this.dirtyFiles();
      if (dirty.length > 0) throw new WorkspaceError(`저장하지 않은 변경이 있다: ${dirty.join(", ")}`);
    }
    if ((await this.git(["rev-list", "--count", `${MAIN}..refs/heads/${branch}`])) === "0") throw new WorkspaceError(`${branch} 에 main 보다 앞선 커밋이 없다`);
    await this.git(["push", "--quiet", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { auth: true });
    const { owner, repo } = this.target();
    const open = (await this.options.remote.listOpenPullRequests({ owner, repo })).find((p) => p.branch === branch && p.author === login);
    if (open) return { number: open.number, url: open.url, branch, existing: true };
    const pr = await this.options.remote.createPullRequest({ repo: { owner, repo }, head: branch, base: MAIN, title: input.title, body: input.body });
    return { ...pr, branch, existing: false };
  }

  /** 내 작업 브랜치 목록(최근 커밋 순). 다른 TC 의 브랜치를 보거나 검토 요청할 때 쓴다 */
  async branches(): Promise<WorkBranchList> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const login = await this.whoami();
    const current = await this.currentBranch();
    const branches: WorkBranch[] = [];
    for (const name of await this.myBranches(login)) {
      branches.push({
        name,
        tcId: workBranchTc(name, login),
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
    if (branch !== MAIN && !(await this.myBranches(await this.whoami())).includes(branch)) throw new WorkspaceError(`내 작업 브랜치가 아니다: ${branch}`);
    if (branch !== (await this.currentBranch())) await this.switchTo(branch, { by: "user" });
    return this.status();
  }

  /**
   * 플로우 만들기를 시작할 때: 이 TC 의 작업 브랜치로, 없으면 main 으로 옮긴다.
   * 다른 TC 의 작업 브랜치에서 TC 를 읽고 재생하고 커밋하지 않게 한다.
   */
  async useTestcaseBranch(id: string): Promise<string> {
    if (!this.connected()) throw new WorkspaceError("워크스페이스를 먼저 연결한다");
    const login = await this.whoami();
    const current = await this.currentBranch();
    if (workBranchTc(current, login) === id) return current;
    const target = (await this.tcBranch(login, id)) ?? MAIN;
    if (target !== current) await this.switchTo(target, { by: "author" });
    return target;
  }
}
