/**
 * 원격 저장소 연동의 유일한 통로(PLAN 10.6, CLAUDE.md 6장). 호출부는 이 인터페이스만 쓴다(GitLab 이전 대비).
 * 토큰은 구현 안에만 있고 URL·로그·오류 메시지·디스크에 나오지 않는다.
 */
export interface RepoRef {
  owner: string;
  repo: string;
}

export interface VerifyResult {
  login: string;
  repos: { owner: string; repo: string; exists: boolean; canPush: boolean }[];
}

/** 토큰으로 볼 수 있는 저장소(설정에서 고르기) */
export interface RepoSummary {
  owner: string;
  repo: string;
  private: boolean;
  canPush: boolean;
}

export interface PullRequestInput {
  repo: RepoRef;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface Release {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  assets: { id: number; name: string; url: string; size: number }[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  createdAt: string;
}

export interface CommitFilesInput {
  repo: RepoRef;
  branch: string;
  message: string;
  files: { path: string; content: string | Buffer }[];
  /** 기존 파일 끝에 줄을 덧붙인다(없으면 만든다). 충돌로 다시 만들 때도 최신 내용에 덧붙인다(증적 색인 index/YYYY-MM.jsonl) */
  appendLines?: { path: string; lines: string[] }[];
}

export interface RemoteProvider {
  /** 토큰 없는 HTTPS clone 주소. 인증은 GIT_ASKPASS 로만 한다 */
  cloneUrl(repo: RepoRef): string;
  fileUrl(repo: RepoRef, path: string, ref: string): string;
  /** 토큰이 유효한지, 각 저장소를 읽고 쓸 수 있는지 */
  verify(repos: RepoRef[]): Promise<VerifyResult>;
  /** 토큰으로 볼 수 있는 저장소(최대 300개, 이름순). 사용자마다 다른 저장소 이름을 목록에서 고르게 한다 */
  listRepos(): Promise<RepoSummary[]>;
  createPullRequest(input: PullRequestInput): Promise<{ number: number; url: string }>;
  /** 열린 PR(최근 50개) */
  listOpenPullRequests(repo: RepoRef): Promise<PullRequestSummary[]>;
  /** 정식 최신 릴리스. 공개 저장소면 토큰 없이도 본다. 없으면 null */
  getLatestRelease(repo: RepoRef): Promise<Release | null>;
  /** 릴리스 파일을 받는다(API 로, 토큰은 있을 때만 GitHub API 호스트에만). 크기가 maxBytes 를 넘으면 받지 않는다 */
  downloadReleaseAsset(repo: RepoRef, asset: { id: number; size: number }, maxBytes: number): Promise<Buffer>;
  /** clone 없이 한 커밋으로 파일을 올린다(Git Data API). 브랜치가 앞서 나가 있으면 최신 위에서 다시 만든다(최대 3회, PLAN 9.4) */
  commitFiles(input: CommitFilesInput): Promise<{ commitSha: string; url: string }>;
}

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

export const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
