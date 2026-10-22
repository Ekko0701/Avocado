import { BundleError, buildSecretSet, buildSummaryBundle, checkBundle, MIN_SECRET_LENGTH, type JpegConverter, type SummaryBundle } from "@qa/evidence";
import type { RemoteProvider } from "@qa/remote";
import type { GitHubSettings, PrepareUploadInput, RunDetail, UploadPreview, UploadRecord } from "@qa/shared";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/database";

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadServiceOptions {
  db: AppDatabase;
  runs: { get(runId: string): RunDetail };
  evidence: { redactedDir(runId: string, executionId: string): string };
  remote: Pick<RemoteProvider, "commitFiles" | "fileUrl">;
  /** D11 정책 스위치 */
  uploadApproved(): boolean;
  github(): GitHubSettings;
  /** 가릴 값 전체(키체인의 계정 값·토큰) */
  secrets(): string[];
  toJpeg: JpegConverter;
  /** 예: "Avocado 0.1.0" */
  generator: string;
  /** 미리보기로 보여 줄 수 있는 캡처 수(넘으면 올리지 않는다). 기본 50 */
  maxImages?: number;
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
const MAX_THUMBNAILS = 50;

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

  private ensureAllowed(): { owner: string; prefix: string } {
    if (!this.options.uploadApproved()) throw new UploadError("증적 업로드가 조직 정책으로 승인되지 않았다(D11). 설정의 조직 정책에서 켠다");
    const g = this.options.github();
    if (!g.owner) throw new UploadError("GitHub 조직 이름을 먼저 설정한다");
    return { owner: g.owner, prefix: g.evidenceRepoPrefix };
  }

  async prepare(input: PrepareUploadInput): Promise<UploadPreview> {
    const { owner, prefix } = this.ensureAllowed();
    const run = this.options.runs.get(input.runId);
    if (run.status === "queued" || run.status === "running") throw new UploadError("끝나지 않은 실행은 올리지 않는다");
    const execution = run.executions.find((e) => e.id === input.executionId);
    if (!execution) throw new UploadError(`실행을 찾지 못했다: ${input.executionId}`);
    const previous = this.uploads(run.id, execution.id)[0];
    if (previous) throw new UploadError(`이미 올린 실행이다: ${previous.url}`);
    const date = this.now();
    const repo = { owner, repo: `${prefix}${date.getFullYear()}` };
    const secrets = this.options.secrets();
    // 너무 짧아 가릴 수 없는 값이 있으면 묶음에 그대로 남을 수 있다(redact.ts MIN_SECRET_LENGTH)
    if (buildSecretSet(secrets).unredactable > 0) throw new UploadError(`가릴 수 없을 만큼 짧은(${MIN_SECRET_LENGTH}자 미만) 비밀 값이 있어 올리지 않는다. 설정에서 확인한다`);
    let bundle: SummaryBundle;
    try {
      bundle = await buildSummaryBundle({
        meta: {
          runId: run.id,
          executionId: execution.id,
          attempt: execution.attempt,
          tcId: run.tcId,
          app: run.app,
          target: run.target,
          flowName: run.flowName,
          deviceName: run.deviceName,
          buildLabel: run.buildLabel,
          result: run.status,
          flaky: run.flaky,
          failureClass: execution.failureClass ?? (run.flaky ? "flaky" : null),
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          generator: this.options.generator,
        },
        redactedDir: this.options.evidence.redactedDir(run.id, execution.id),
        includePassScreens: input.includePassScreens,
        secrets,
        toJpeg: this.options.toJpeg,
        date,
      });
    } catch (error) {
      if (error instanceof BundleError) throw new UploadError(error.message);
      throw error;
    }
    const images = bundle.files.filter((f) => f.kind === "screen" || f.kind === "failure_screen");
    // 미리보기로 보지 않은 캡처는 올리지 않는다
    const maxImages = this.options.maxImages ?? MAX_THUMBNAILS;
    if (images.length > maxImages) throw new UploadError(`캡처가 ${maxImages}장을 넘어 미리보기로 모두 확인할 수 없다(${images.length}장). 화면 캡처를 빼고 다시 만든다`);
    const residue = checkBundle(bundle, secrets);
    const blocked = residue.length > 0;
    this.sweep();
    let bundleId: string | null = null;
    if (!blocked) {
      bundleId = this.newId();
      this.prepared.set(bundleId, {
        bundle,
        runId: run.id,
        executionId: execution.id,
        repo,
        message: `evidence: ${run.tcId} ${run.target} ${run.status} ${run.id}`,
        expiresAt: date.getTime() + PREPARED_TTL_MS,
      });
    }
    return {
      bundleId,
      repo: `${repo.owner}/${repo.repo}`,
      root: bundle.root,
      files: bundle.files.map((f) => ({ path: f.path, kind: f.kind, bytes: f.content.length })),
      thumbnails: images.map((f) => ({ path: f.path, dataUrl: `data:image/jpeg;base64,${f.content.toString("base64")}` })),
      totalBytes: bundle.totalBytes,
      warnings: bundle.warnings,
      blocked,
      residue,
    };
  }

  async upload(input: { bundleId: string; privacyConfirmed: true }): Promise<UploadRecord> {
    this.ensureAllowed();
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
