import { findResidueInFiles, type BundleFile } from "@qa/evidence";
import type { EvidenceExportRecord, ExportPreview, PrepareUploadInput } from "@qa/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildGatedBundle, bundlePreview, finishedExecution, type BundleGateOptions } from "./bundle-gate";

export class EvidenceExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceExportError";
  }
}

export interface EvidenceExportOptions extends BundleGateOptions {
  /** main 이 연 창에서 사람이 고른 폴더. 취소하면 null */
  pickFolder(): Promise<string | null>;
  /** Finder 에서 보이기 */
  reveal(path: string): void;
  /** 보여 줄 경로에서 ~ 로 줄일 홈 폴더 */
  home: string;
  now?: () => Date;
  newId?: () => string;
}

interface Prepared {
  files: BundleFile[];
  folderName: string;
  expiresAt: number;
}

const PREPARED_TTL_MS = 30 * 60_000;
const MAX_SUFFIX = 99;
const fail = (message: string) => new EvidenceExportError(message);

/** 고른 폴더 안에 만들 이름. 받는 사람이 무엇의 증적인지 알 수 있게 테스트 케이스 id 를 넣는다 */
export function exportFolderName(tcId: string, runId: string, attempt: number): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "run";
  return `avocado-evidence-${safe(tcId)}-${safe(runId).slice(0, 8)}${attempt > 1 ? `-attempt-${attempt}` : ""}`;
}

/**
 * 묶음을 parent 안의 새 폴더 하나에 쓴다. 숨긴 임시 폴더에 다 쓴 뒤 이름을 바꾸므로 반쯤 쓴 폴더가 남지 않는다.
 * 같은 이름이 있으면 덮어쓰지 않고 -2, -3 을 붙인다. 묶음 안의 경로가 새 폴더 밖을 가리키면 아무것도 남기지 않고 거절한다
 */
export function writeBundleFolder(parent: string, name: string, files: readonly BundleFile[]): string {
  if (!isAbsolute(parent)) throw fail("내보낼 폴더가 절대 경로가 아니다");
  const temp = mkdtempSync(join(parent, ".avocado-evidence-"));
  try {
    for (const file of files) {
      const target = resolve(temp, file.path);
      const rel = relative(temp, target);
      if (rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) throw fail(`묶음의 경로가 내보낼 폴더 밖을 가리킨다: ${file.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: "wx" });
    }
    for (let n = 1; n <= MAX_SUFFIX; n += 1) {
      const final = join(parent, n === 1 ? name : `${name}-${n}`);
      try {
        // 빈 폴더를 먼저 만들어 이름을 차지한다. 이름 바꾸기는 빈 폴더만 대신한다
        mkdirSync(final);
      } catch (error) {
        if ((error as { code?: unknown }).code === "EEXIST") continue;
        throw error;
      }
      try {
        renameSync(temp, final);
      } catch (error) {
        rmdirSync(final);
        throw error;
      }
      return final;
    }
    throw fail(`${name} 부터 ${name}-${MAX_SUFFIX} 까지 모두 있다. 다른 폴더를 고른다`);
  } catch (error) {
    // 이번에 만든 숨긴 임시 폴더만 지운다
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 증적 폴더로 내보내기(ADR 0036 결정 9, T-126). 게이트는 올리기와 같다(가릴 수 없는 값, 가린 사본, 잔존 검사, 미리보기, "개인정보 확인함").
 * 정책 스위치(D11)는 외부 GitHub 업로드에 대한 승인이라 보지 않는다. 워크스페이스 출처와도 상관없다.
 * 저장할 폴더는 렌더러가 보내지 않는다. main 이 연 창에서 사람이 고른다.
 */
export class EvidenceExportService {
  private readonly prepared = new Map<string, Prepared>();
  private readonly exported = new Map<string, string>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: EvidenceExportOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  async prepare(input: PrepareUploadInput): Promise<ExportPreview> {
    const date = this.now();
    const run = this.options.runs.get(input.runId);
    const execution = finishedExecution(run, input.executionId, "내보내지", fail);
    const gated = await buildGatedBundle(this.options, { run, execution, includePassScreens: input.includePassScreens, date }, "내보내지", fail);
    const folderName = exportFolderName(run.tcId, run.id, execution.attempt);
    this.sweep();
    let bundleId: string | null = null;
    if (gated.residue.length === 0) {
      bundleId = this.newId();
      this.prepared.set(bundleId, { files: gated.bundle.files, folderName, expiresAt: date.getTime() + PREPARED_TTL_MS });
    }
    return { ...bundlePreview(gated, bundleId), folderName };
  }

  async export(input: { bundleId: string; privacyConfirmed: true }): Promise<EvidenceExportRecord | null> {
    if (input.privacyConfirmed !== true) throw fail("개인정보 확인이 필요하다");
    this.sweep();
    const p = this.prepared.get(input.bundleId);
    if (!p) throw fail("미리보기가 없거나 만료됐다. 다시 만든다");
    const parent = await this.options.pickFolder();
    // 취소하면 미리보기를 남겨 다시 고를 수 있게 한다
    if (parent === null) return null;
    // 미리보기 뒤에 계정 값이 바뀌었을 수 있다. 쓰기 직전에 다시 검사한다
    if (findResidueInFiles(p.files, this.options.secrets()).length > 0) throw fail("묶음에 비밀 값이 남아 있어 내보내지 않는다. 다시 만든다");
    const folder = writeBundleFolder(parent, p.folderName, p.files);
    this.prepared.delete(input.bundleId);
    const exportId = this.newId();
    this.exported.set(exportId, folder);
    const home = this.options.home;
    return {
      exportId,
      folder: folder === home || folder.startsWith(`${home}${sep}`) ? `~${folder.slice(home.length)}` : folder,
      files: p.files.length,
      bytes: p.files.reduce((n, f) => n + f.content.length, 0),
    };
  }

  reveal(input: { exportId: string }): { opened: true } {
    const folder = this.exported.get(input.exportId);
    if (!folder) throw fail("이번에 내보낸 폴더가 아니다");
    this.options.reveal(folder);
    return { opened: true };
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (const [id, p] of this.prepared) if (p.expiresAt < now) this.prepared.delete(id);
  }
}
