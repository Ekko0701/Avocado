import { checkBundle, type SummaryBundle } from "@qa/evidence";
import type { RemoteProvider } from "@qa/remote";
import { evidenceRepoOf, localWorkspaceRefusal, type GitHubSettings, type PrepareUploadInput, type UploadPreview, type UploadRecord, type WorkspaceSourceKind } from "@qa/shared";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/database";
import { buildGatedBundle, bundlePreview, finishedExecution, type BundleGateOptions } from "./bundle-gate";

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadServiceOptions extends BundleGateOptions {
  db: AppDatabase;
  remote: Pick<RemoteProvider, "commitFiles" | "fileUrl">;
  /** D11 정책 스위치 */
  uploadApproved(): boolean;
  /** 워크스페이스의 출처(ADR 0036). 로컬에는 올리기가 없다 */
  source(): WorkspaceSourceKind;
  github(): GitHubSettings;
  now?: () => Date;
  newId?: () => string;
}

interface Prepared {
  bundle: SummaryBundle;
  runId: string;
  executionId: string;
  repo: { owner: string; repo: string };
  message: string;
  expiresAt: number;
}

const PREPARED_TTL_MS = 30 * 60_000;
const fail = (message: string) => new UploadError(message);

/**
 * 증적 요약 묶음 업로드(PLAN 9.2~9.4). 정책 스위치가 꺼져 있으면 아무것도 하지 않는다.
 * 1) 가린 사본으로 묶음을 만들고 2) 비밀 값 잔존 검사 3) 미리보기 → "개인정보 확인함" 뒤에만 올린다.
 * 원본(raw/)은 읽지 않는다. 올리기 직전에 잔존 검사를 한 번 더 한다.
 */
export class UploadService {
  private readonly prepared = new Map<string, Prepared>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: UploadServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** 업로드가 허용됐는지 보고 그 해의 증적 저장소를 돌려준다(이름을 그대로 정했으면 그 저장소, 아니면 접두사 + 연도) */
  private ensureAllowed(year: number): { owner: string; repo: string } {
    if (this.options.source() === "local") throw new UploadError(localWorkspaceRefusal("증적 올리기"));
    if (!this.options.uploadApproved()) throw new UploadError("증적 업로드가 조직 정책으로 승인되지 않았다(D11). 설정의 조직 정책에서 켠다");
    const repo = evidenceRepoOf(this.options.github(), year);
    if (!repo) throw new UploadError("GitHub 조직 이름을 먼저 설정한다");
    return repo;
  }

  async prepare(input: PrepareUploadInput): Promise<UploadPreview> {
    const date = this.now();
    const repo = this.ensureAllowed(date.getFullYear());
    const run = this.options.runs.get(input.runId);
    const execution = finishedExecution(run, input.executionId, "올리지", fail);
    const previous = this.uploads(run.id, execution.id)[0];
    if (previous) throw new UploadError(`이미 올린 실행이다: ${previous.url}`);
    const gated = await buildGatedBundle(this.options, { run, execution, includePassScreens: input.includePassScreens, date }, "올리지", fail);
    this.sweep();
    let bundleId: string | null = null;
    if (gated.residue.length === 0) {
      bundleId = this.newId();
      this.prepared.set(bundleId, {
        bundle: gated.bundle,
        runId: run.id,
        executionId: execution.id,
        repo,
        message: `evidence: ${run.tcId} ${run.target} ${run.status} ${run.id}`,
        expiresAt: date.getTime() + PREPARED_TTL_MS,
      });
    }
    return { ...bundlePreview(gated, bundleId), repo: `${repo.owner}/${repo.repo}`, root: gated.bundle.root };
  }

  async upload(input: { bundleId: string; privacyConfirmed: true }): Promise<UploadRecord> {
    // 올릴 저장소는 미리보기 때 정한 것을 쓴다. 여기서는 정책과 설정이 그대로인지만 본다
    this.ensureAllowed(this.now().getFullYear());
    if (input.privacyConfirmed !== true) throw new UploadError("개인정보 확인이 필요하다");
    this.sweep();
    const p = this.prepared.get(input.bundleId);
    if (!p) throw new UploadError("미리보기가 없거나 만료됐다. 다시 만든다");
    // 미리보기 뒤에 계정 값이 바뀌었을 수 있다. 올리기 직전에 다시 검사한다
    if (checkBundle(p.bundle, this.options.secrets()).length > 0) throw new UploadError("묶음에 비밀 값이 남아 있어 올리지 않는다. 다시 만든다");
    this.prepared.delete(input.bundleId);
    let commit: { commitSha: string };
    try {
      commit = await this.options.remote.commitFiles({
        repo: p.repo,
        branch: "main",
        message: p.message,
        files: p.bundle.files.map((f) => ({ path: `${p.bundle.root}/${f.path}`, content: f.content })),
        appendLines: [{ path: p.bundle.indexPath, lines: [p.bundle.indexLine] }],
      });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 404) throw new UploadError(`증적 저장소 ${p.repo.owner}/${p.repo.repo} 이 없거나 권한이 없다. 운영자에게 만들어 달라고 한다(PLAN 9.4)`);
      throw error;
    }
    const record: UploadRecord = {
      repo: `${p.repo.owner}/${p.repo.repo}`,
      path: p.bundle.root,
      commitSha: commit.commitSha,
      url: this.options.remote.fileUrl(p.repo, `${p.bundle.root}/report.md`, commit.commitSha),
      bytes: p.bundle.totalBytes,
      uploadedAt: this.now().toISOString(),
    };
    this.options.db.db
      .prepare("INSERT INTO upload (execution_id, repo, path, commit_sha, url, bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.executionId, record.repo, record.path, record.commitSha, record.url, record.bytes, record.uploadedAt);
    return record;
  }

  uploads(runId: string, executionId: string): UploadRecord[] {
    this.options.evidence.redactedDir(runId, executionId);
    const rows = this.options.db.db
      .prepare("SELECT repo, path, commit_sha, url, bytes, uploaded_at FROM upload WHERE execution_id = ? ORDER BY uploaded_at DESC")
      .all(executionId) as unknown as { repo: string; path: string; commit_sha: string; url: string; bytes: number; uploaded_at: string }[];
    return rows.map((r) => ({ repo: r.repo, path: r.path, commitSha: r.commit_sha, url: r.url, bytes: r.bytes, uploadedAt: r.uploaded_at }));
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (const [id, p] of this.prepared) if (p.expiresAt < now) this.prepared.delete(id);
  }
}
