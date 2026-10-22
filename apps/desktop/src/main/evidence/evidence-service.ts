import { parseExecution } from "@qa/evidence";
import type { EvidenceArtifact, EvidenceFile, EvidenceSearchResult, HierarchyView } from "@qa/shared";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "../db/database";

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

export interface EvidenceServiceOptions {
  db: AppDatabase;
  /** userData/evidence */
  evidenceRoot: string;
  /** 텍스트를 한 번에 보낼 최대 크기. 넘으면 끝부분만 보낸다. 기본 512KB */
  maxTextBytes?: number;
  /** 캡처 최대 크기. 기본 10MB */
  maxImageBytes?: number;
}

/** 검색 대상: 로그·콘솔·JUnit. 화면 트리·명령 메타데이터는 화면에서 따로 본다 */
const SEARCH_KINDS = new Set<EvidenceArtifact["kind"]>(["console_log", "junit", "maestro_log", "device_log", "runner_log"]);
const MAX_MATCHES = 300;
const MAX_SEARCH_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NODES = 5000;

/** Maestro 화면 트리(`maestro hierarchy`, screen-hierarchy/*.json). 쓰는 필드만 본다 */
interface TreeNode {
  attributes?: Record<string, string>;
  children?: TreeNode[];
}
const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z
    .object({
      attributes: z.record(z.string(), z.string()).optional(),
      children: z.array(TreeNodeSchema).optional(),
    })
    .loose(),
);

/**
 * 결과 화면(T-108)이 실행 증적을 읽는 유일한 통로.
 * 실행의 가린 사본(redacted)만 연다. 경로는 그 폴더 안으로 제한하고 심볼릭 링크를 따라가지 않는다(CLAUDE.md 5장, PLAN 9.1).
 */
export class EvidenceService {
  constructor(private readonly options: EvidenceServiceOptions) {}

  /** 실행의 가린 사본 폴더(실제 경로). 실행이 그 run 에 속하는지도 확인한다 */
  redactedDir(runId: string, executionId: string): string {
    const row = this.options.db.db
      .prepare("SELECT e.evidence_dir, r.evidence_removed_at FROM execution e JOIN run r ON r.id = e.run_id WHERE e.id = ? AND e.run_id = ?")
      .get(executionId, runId) as { evidence_dir: string | null; evidence_removed_at: string | null } | undefined;
    if (row?.evidence_removed_at) throw new EvidenceError("보관 기간이 지나 이 실행의 로컬 증적을 지웠다(설정의 보관 일수, PLAN 9.1)");
    if (!row?.evidence_dir) throw new EvidenceError(`실행 증적을 찾지 못했다: ${runId}/${executionId}`);
    const dir = join(this.options.evidenceRoot, row.evidence_dir, "redacted");
    if (!existsSync(dir)) throw new EvidenceError("가린 증적이 없다(실행이 끝나지 않았거나 가림에 실패했다)");
    return realpathSync(dir);
  }

  /** 상대 경로를 가린 사본 안의 실제 파일로. 밖을 가리키거나 링크면 거부한다 */
  private resolve(runId: string, executionId: string, path: string): string {
    if (isAbsolute(path) || path.includes("\0") || normalize(path).split(/[\\/]/).includes("..")) throw new EvidenceError("증적 폴더 밖의 경로다");
    const dir = this.redactedDir(runId, executionId);
    const abs = join(dir, path);
    if (!existsSync(abs)) throw new EvidenceError(`증적 파일이 없다: ${path}`);
    if (lstatSync(abs).isSymbolicLink()) throw new EvidenceError("심볼릭 링크는 열지 않는다");
    const real = realpathSync(abs);
    if (!real.startsWith(`${dir}${sep}`) || !statSync(real).isFile()) throw new EvidenceError("증적 폴더 밖의 경로다");
    return real;
  }

  list(runId: string, executionId: string): EvidenceArtifact[] {
    return parseExecution({ dir: this.redactedDir(runId, executionId) }).artifacts;
  }

  file(runId: string, executionId: string, path: string): EvidenceFile {
    const abs = this.resolve(runId, executionId, path);
    const bytes = statSync(abs).size;
    const lower = path.toLowerCase();
    if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      if (bytes > (this.options.maxImageBytes ?? 10 * 1024 * 1024)) throw new EvidenceError(`캡처가 너무 크다(${bytes}바이트)`);
      const mime = lower.endsWith(".png") ? "image/png" : "image/jpeg";
      return { kind: "image", path, mime, dataUrl: `data:${mime};base64,${readFileSync(abs).toString("base64")}`, bytes };
    }
    const max = this.options.maxTextBytes ?? 512 * 1024;
    if (bytes <= max) {
      const content = readFileSync(abs);
      if (content.subarray(0, 8192).includes(0)) throw new EvidenceError("텍스트 파일이 아니다");
      return { kind: "text", path, text: content.toString("utf8"), truncated: false, firstLine: 1, bytes };
    }
    // 큰 로그는 끝부분이 실패 시점에 가깝다. 잘린 첫 줄은 버리고 줄 번호를 맞춘다.
    const fd = openSync(abs, "r");
    try {
      const tail = Buffer.alloc(max);
      readSync(fd, tail, 0, max, bytes - max);
      const text = tail.toString("utf8");
      const cut = text.indexOf("\n") + 1;
      const head = readFileSync(abs).subarray(0, bytes - max + cut);
      let newlines = 0;
      for (const b of head) if (b === 0x0a) newlines += 1;
      return { kind: "text", path, text: text.slice(cut), truncated: true, firstLine: newlines + 1, bytes };
    } finally {
      closeSync(fd);
    }
  }

  search(runId: string, executionId: string, query: string): EvidenceSearchResult {
    const needle = query.toLowerCase();
    const dir = this.redactedDir(runId, executionId);
    const matches: EvidenceSearchResult["matches"] = [];
    let truncated = false;
    for (const a of parseExecution({ dir }).artifacts) {
      if (!SEARCH_KINDS.has(a.kind) || a.bytes > MAX_SEARCH_FILE_BYTES) continue;
      const lines = readFileSync(this.resolve(runId, executionId, a.path), "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!line.toLowerCase().includes(needle)) continue;
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({ path: a.path, line: i + 1, text: line.length > 500 ? `${line.slice(0, 500)}…` : line });
      }
      if (truncated) break;
    }
    return { matches, truncated };
  }

  hierarchy(runId: string, executionId: string, path: string): HierarchyView {
    const abs = this.resolve(runId, executionId, path);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    } catch (error) {
      throw new EvidenceError(`화면 트리를 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = TreeNodeSchema.safeParse(json);
    if (!parsed.success) throw new EvidenceError(`화면 트리 형식이 다르다: ${parsed.error.issues[0]?.message ?? ""}`);
    const nodes: HierarchyView["nodes"] = [];
    let truncated = false;
    const visit = (n: TreeNode, depth: number) => {
      if (truncated) return;
      const a = n.attributes ?? {};
      const text = (a["text"] || a["accessibilityText"] || a["hintText"] || a["value"] || "").trim();
      const id = (a["resource-id"] || a["identifier"] || "").trim();
      if (text || id) {
        if (nodes.length >= MAX_NODES) {
          truncated = true;
          return;
        }
        nodes.push({ depth, text, id, className: a["class"] ?? "", bounds: a["bounds"] ?? "", enabled: a["enabled"] !== "false" });
      }
      for (const c of n.children ?? []) visit(c, depth + 1);
    };
    visit(parsed.data, 0);
    return { nodes, truncated };
  }
}
