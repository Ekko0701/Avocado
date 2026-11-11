import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export class QaDoorayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaDoorayError";
  }
}

export interface QaDoorayOptions {
  /** 저장해 둔 두레이 토큰. 없으면 null */
  token: () => string | null;
  /** Electron 의 net.fetch 를 넘긴다. Node 의 fetch 는 시스템 인증서를 보지 않아 회사 보안 인증서를 거치는 망에서 실패한다 */
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;
}

const API = "https://api.dooray.com";
const PAGE_SIZE = 100;
/** 프로젝트·태그가 이보다 많으면 앞쪽만 보여 준다 */
const MAX_PAGES = 10;

const PageSchema = z.object({
  header: z.object({ isSuccessful: z.boolean(), resultMessage: z.string().optional() }),
  result: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});

/** 자동 처리 설정 화면이 프로젝트와 태그를 골라 넣을 수 있게 두레이에서 목록만 읽어 온다. 쓰기는 하지 않는다 */
export class QaDooray {
  constructor(private readonly options: QaDoorayOptions) {}

  private async all(path: string): Promise<Record<string, unknown>[]> {
    const token = this.options.token();
    if (!token) throw new QaDoorayError("두레이 토큰을 먼저 저장한다");
    const out: Record<string, unknown>[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.options.fetch(`${API}${path}${path.includes("?") ? "&" : "?"}size=${PAGE_SIZE}&page=${page}`, {
        headers: { Authorization: `dooray-api ${token}` },
      });
      if (response.status === 401 || response.status === 403) throw new QaDoorayError("두레이 토큰이 맞지 않거나 권한이 없다");
      if (response.status !== 200) throw new QaDoorayError(`두레이 조회에 실패했다 (${response.status})`);
      const body = PageSchema.parse(await response.json());
      if (!body.header.isSuccessful) throw new QaDoorayError(`두레이 조회에 실패했다: ${body.header.resultMessage ?? ""}`);
      const items = body.result ?? [];
      out.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
    return out;
  }

  /** 내가 속한 프로젝트 */
  async projects(): Promise<{ id: string; name: string }[]> {
    const items = await this.all("/project/v1/projects?member=me");
    return items.flatMap((p) => (typeof p["id"] === "string" && typeof p["code"] === "string" ? [{ id: p["id"], name: p["code"] }] : [])).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 프로젝트의 태그 이름 */
  async tags(projectId: string): Promise<string[]> {
    const items = await this.all(`/project/v1/projects/${encodeURIComponent(projectId)}/tags`);
    return items.flatMap((t) => (typeof t["name"] === "string" ? [t["name"]] : [])).sort((a, b) => a.localeCompare(b));
  }
}

const ClaudeConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.object({ env: z.record(z.string(), z.unknown()).optional() })).optional(),
});

/** Claude Code 설정 파일(~/.claude.json)에 등록된 MCP 서버 중 DOORAY_API_KEY 를 가진 것의 값. 없거나 읽을 수 없으면 null */
export function findClaudeDoorayToken(file: string): string | null {
  if (!existsSync(file)) return null;
  let config: z.infer<typeof ClaudeConfigSchema>;
  try {
    config = ClaudeConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
  for (const server of Object.values(config.mcpServers ?? {})) {
    const value = server.env?.["DOORAY_API_KEY"];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
