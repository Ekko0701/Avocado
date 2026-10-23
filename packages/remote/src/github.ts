import { Octokit } from "@octokit/rest";
import { RemoteError, type CommitFilesInput, type PullRequestInput, type PullRequestSummary, type Release, type RemoteProvider, type RepoRef, type RepoSummary, type VerifyResult } from "./provider";
import { scrubSecrets } from "./scrub";

export interface GitHubProviderOptions {
  /** 호출할 때마다 읽는다(설정에서 바꾸면 바로 반영). 값은 이 클래스 밖으로 나가지 않는다 */
  token: () => string | null;
  /** 기본 https://api.github.com. 테스트는 가짜 서버 */
  apiUrl?: string;
  /** 기본 https://github.com */
  webUrl?: string;
  /** 요청 기록(메서드·경로·상태·시간). 헤더와 본문은 넣지 않는다 */
  log?: (entry: { method: string; path: string; status: number | null; ms: number }) => void;
  userAgent?: string;
}

const MAX_REF_ATTEMPTS = 3;

/** GitHub 구현. Octokit 은 이 파일에서만 쓴다(CLAUDE.md 6장) */
export class GitHubProvider implements RemoteProvider {
  private readonly webUrl: string;

  constructor(private readonly options: GitHubProviderOptions) {
    this.webUrl = (options.webUrl ?? "https://github.com").replace(/\/+$/, "");
  }

  /**
   * timeoutMs: 이 클라이언트로 하는 요청 전체의 제한 시간(응답 없는 GitHub 이 화면을 붙잡지 않게).
   * anonymous: 공개 저장소 읽기(배포 저장소의 릴리스). 토큰이 있으면 쓰고(요청 한도가 크다), 없으면 인증 없이 부른다
   */
  private client(timeoutMs = 60_000, opts: { anonymous?: boolean } = {}): { octokit: Octokit; token: string } {
    const token = this.options.token();
    if (!token && !opts.anonymous) throw new RemoteError("GitHub 토큰이 없다. 설정에서 저장한다");
    const octokit = new Octokit({
      ...(token ? { auth: token } : {}),
      request: { signal: AbortSignal.timeout(timeoutMs) },
      baseUrl: this.options.apiUrl ?? "https://api.github.com",
      userAgent: this.options.userAgent ?? "qa-tool",
      // Octokit 자체 로그는 쓰지 않고 아래 훅으로 남긴다
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    octokit.hook.wrap("request", async (request, opts) => {
      const started = Date.now();
      const path = String(opts.url).split("?")[0] ?? "";
      try {
        const res = await request(opts);
        this.options.log?.({ method: String(opts.method), path, status: res.status, ms: Date.now() - started });
        return res;
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
        this.options.log?.({ method: String(opts.method), path, status, ms: Date.now() - started });
        throw error;
      }
    });
    return { octokit, token: token ?? "" };
  }

  /** Octokit 오류를 토큰 없는 RemoteError 로 바꾼다 */
  private fail(error: unknown, token: string, action: string): never {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
    const raw = error instanceof Error ? error.message : String(error);
    const reason =
      status === 401
        ? "토큰이 유효하지 않거나 만료됐다"
        : status === 403
          ? "권한이 없다(토큰 권한이나 조직 승인을 확인한다)"
          : status === 404
            ? "저장소나 대상을 찾지 못했다(이름이나 토큰의 저장소 권한을 확인한다)"
            : scrubSecrets(raw, [token]);
    throw new RemoteError(`${action}: ${reason}`, status);
  }

  cloneUrl(repo: RepoRef): string {
    return `${this.webUrl}/${repo.owner}/${repo.repo}.git`;
  }

  fileUrl(repo: RepoRef, path: string, ref: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${this.webUrl}/${repo.owner}/${repo.repo}/blob/${encodeURIComponent(ref)}/${encoded}`;
  }

  async verify(repos: RepoRef[]): Promise<VerifyResult> {
    const { octokit, token } = this.client();
    let login: string;
    try {
      login = (await octokit.users.getAuthenticated()).data.login;
    } catch (error) {
      this.fail(error, token, "GitHub 연결 확인");
    }
    const results: VerifyResult["repos"] = [];
    for (const r of repos) {
      try {
        const { data } = await octokit.repos.get({ owner: r.owner, repo: r.repo });
        results.push({ ...r, exists: true, canPush: data.permissions?.push === true });
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 404) results.push({ ...r, exists: false, canPush: false });
        else this.fail(error, token, `저장소 확인(${r.owner}/${r.repo})`);
      }
    }
    return { login, repos: results };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const { octokit, token } = this.client();
    try {
      // fine-grained 토큰이면 그 토큰에 고른 저장소만 온다. 최대 300개(3쪽)
      const out: RepoSummary[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const { data } = await octokit.repos.listForAuthenticatedUser({ per_page: 100, page, sort: "full_name" });
        out.push(...data.map((r) => ({ owner: r.owner.login, repo: r.name, private: r.private, canPush: r.permissions?.push === true })));
        if (data.length < 100) break;
      }
      return out;
    } catch (error) {
      this.fail(error, token, "저장소 목록");
    }
  }

  async createPullRequest(input: PullRequestInput): Promise<{ number: number; url: string }> {
    const { octokit, token } = this.client();
    try {
      const { data } = await octokit.pulls.create({
        owner: input.repo.owner,
        repo: input.repo.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        draft: input.draft ?? false,
      });
      return { number: data.number, url: data.html_url };
    } catch (error) {
      this.fail(error, token, "PR 만들기");
    }
  }

  async listOpenPullRequests(repo: RepoRef): Promise<PullRequestSummary[]> {
    const { octokit, token } = this.client();
    try {
      // 열린 PR 최대 300개(3쪽)
      const out: PullRequestSummary[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const { data } = await octokit.pulls.list({ owner: repo.owner, repo: repo.repo, state: "open", per_page: 100, page });
        out.push(...data.map((p) => ({ number: p.number, title: p.title, url: p.html_url, branch: p.head.ref, author: p.user?.login ?? "", createdAt: p.created_at })));
        if (data.length < 100) break;
      }
      return out;
    } catch (error) {
      this.fail(error, token, `PR 목록(${repo.owner}/${repo.repo})`);
    }
  }

  async getLatestRelease(repo: RepoRef): Promise<Release | null> {
    const { octokit, token } = this.client(60_000, { anonymous: true });
    try {
      const { data } = await octokit.repos.getLatestRelease({ owner: repo.owner, repo: repo.repo });
      return {
        tag: data.tag_name,
        name: data.name ?? data.tag_name,
        url: data.html_url,
        publishedAt: data.published_at ?? null,
        assets: data.assets.map((a) => ({ id: a.id, name: a.name, url: a.browser_download_url, size: a.size })),
      };
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) return null;
      this.fail(error, token, "최신 릴리스 확인");
    }
  }

  async downloadReleaseAsset(repo: RepoRef, asset: { id: number; size: number }, maxBytes: number): Promise<Buffer> {
    if (asset.size > maxBytes) throw new RemoteError(`릴리스 파일이 너무 크다(${asset.size}바이트)`);
    const { octokit, token } = this.client(15 * 60_000, { anonymous: true });
    try {
      // 저장소 파일 저장소(S3 등)로 넘겨질 때 fetch 는 다른 호스트로 Authorization 을 보내지 않는다
      const { data } = await octokit.repos.getReleaseAsset({ owner: repo.owner, repo: repo.repo, asset_id: asset.id, headers: { accept: "application/octet-stream" } });
      const buffer = Buffer.from(data as unknown as ArrayBuffer);
      if (buffer.length > maxBytes) throw new RemoteError(`릴리스 파일이 너무 크다(${buffer.length}바이트)`);
      return buffer;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      this.fail(error, token, "릴리스 파일 받기");
    }
  }

  async commitFiles(input: CommitFilesInput): Promise<{ commitSha: string; url: string }> {
    const { octokit, token } = this.client(10 * 60_000);
    const { owner, repo } = input.repo;
    try {
      const blobs = await Promise.all(
        input.files.map(async (f) => {
          const content = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content;
          const { data } = await octokit.git.createBlob({ owner, repo, content: content.toString("base64"), encoding: "base64" });
          return { path: f.path, sha: data.sha };
        }),
      );
      for (let attempt = 1; attempt <= MAX_REF_ATTEMPTS; attempt += 1) {
        const head = (await octokit.git.getRef({ owner, repo, ref: `heads/${input.branch}` })).data.object.sha;
        const baseTree = (await octokit.git.getCommit({ owner, repo, commit_sha: head })).data.tree.sha;
        // 덧붙이기는 이번 머리의 내용을 읽어 그 뒤에 붙인다(충돌로 다시 만들면 새 머리에서 다시 읽는다)
        const appended = await Promise.all(
          (input.appendLines ?? []).map(async (a) => {
            const current = await this.readFile(octokit, { owner, repo }, a.path, head);
            const prefix = current === null || current === "" ? "" : current.endsWith("\n") ? current : `${current}\n`;
            const { data } = await octokit.git.createBlob({ owner, repo, content: Buffer.from(`${prefix}${a.lines.map((l) => `${l}\n`).join("")}`, "utf8").toString("base64"), encoding: "base64" });
            return { path: a.path, sha: data.sha };
          }),
        );
        const tree = await octokit.git.createTree({
          owner,
          repo,
          base_tree: baseTree,
          tree: [...blobs, ...appended].map((b) => ({ path: b.path, mode: "100644" as const, type: "blob" as const, sha: b.sha })),
        });
        const commit = await octokit.git.createCommit({ owner, repo, message: input.message, tree: tree.data.sha, parents: [head] });
        try {
          await octokit.git.updateRef({ owner, repo, ref: `heads/${input.branch}`, sha: commit.data.sha, force: false });
          return { commitSha: commit.data.sha, url: `${this.webUrl}/${owner}/${repo}/commit/${commit.data.sha}` };
        } catch (error) {
          // 그 사이 다른 커밋이 올라왔다(fast-forward 아님). 최신 위에서 다시 만든다
          if ((error as { status?: unknown }).status !== 422 || attempt === MAX_REF_ATTEMPTS) throw error;
        }
      }
      throw new RemoteError("브랜치 갱신이 계속 충돌했다");
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      this.fail(error, token, `커밋 올리기(${owner}/${repo}@${input.branch})`);
    }
  }

  /** 파일 내용(UTF-8). 없으면 null */
  private async readFile(octokit: Octokit, repo: RepoRef, path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await octokit.repos.getContent({ owner: repo.owner, repo: repo.repo, path, ref });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) throw new RemoteError(`파일이 아니다: ${path}`);
      // 큰 파일(1MB 초과)은 내용 없이 올 수 있다. 빈 내용으로 덮어쓰지 않게 막는다
      if (!("encoding" in data) || data.encoding !== "base64") throw new RemoteError(`파일 내용을 읽지 못했다(인코딩 ${"encoding" in data ? String(data.encoding) : "없음"}): ${path}`);
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  }
}
