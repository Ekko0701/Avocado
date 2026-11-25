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

const BodySchema = z.object({
  header: z.object({ isSuccessful: z.boolean(), resultMessage: z.string().optional() }),
  result: z.unknown(),
});
const ItemsSchema = z.array(z.record(z.string(), z.unknown())).nullable().optional();

export interface QaDoorayTicket {
  /** {프로젝트 코드}/{업무번호}. QA 작업 기록의 ticket 과 같은 모양 */
  ticket: string;
  postId: string;
}

/** 설정 화면에 보일 프로젝트·태그 목록과, 자동 처리가 볼 열린 티켓을 두레이에서 읽어 온다. 쓰기는 하지 않는다 */
export class QaDooray {
  constructor(private readonly options: QaDoorayOptions) {}

  /** 이름으로 찾은 id. 확인할 때마다 목록을 다시 받지 않는다. 토큰이 바뀌면 비운다 */
  private readonly ids = new Map<string, string>();
  private idsToken: string | null = null;

  private async request(path: string): Promise<unknown> {
    const token = this.options.token();
    if (!token) throw new QaDoorayError("두레이 토큰을 먼저 저장한다");
    if (token !== this.idsToken) {
      this.ids.clear();
      this.idsToken = token;
    }
    const response = await this.options.fetch(`${API}${path}`, { headers: { Authorization: `dooray-api ${token}` } });
    const where = `${response.status} ${path.split("?")[0]}`;
    if (response.status === 401 || response.status === 403) throw new QaDoorayError(`두레이 토큰이 맞지 않거나 권한이 없다 (${where})`);
    if (response.status !== 200) throw new QaDoorayError(`두레이 조회에 실패했다 (${where})`);
    const body = BodySchema.parse(await response.json());
    if (!body.header.isSuccessful) throw new QaDoorayError(`두레이 조회에 실패했다: ${body.header.resultMessage ?? ""}`);
    return body.result;
  }

  private async all(path: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const items = ItemsSchema.parse(await this.request(`${path}${path.includes("?") ? "&" : "?"}size=${PAGE_SIZE}&page=${page}`)) ?? [];
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

  private async id(key: string, find: () => Promise<unknown>, missing: string): Promise<string> {
    const cached = this.ids.get(key);
    if (cached) return cached;
    const found = await find();
    if (typeof found !== "string" || !found) throw new QaDoorayError(missing);
    this.ids.set(key, found);
    return found;
  }

  /** 태그가 붙은, 아직 끝나지 않은 티켓. 먼저 등록된 것부터 */
  async openTickets(watch: { project: string; tag: string; scope: "all" | "assigned_to_me" }): Promise<QaDoorayTicket[]> {
    const projectId = await this.id(`project:${watch.project}`, async () => (await this.projects()).find((p) => p.name === watch.project)?.id, `프로젝트를 찾지 못했다: ${watch.project}`);
    const tags = `/project/v1/projects/${encodeURIComponent(projectId)}/tags`;
    const tagId = await this.id(`tag:${projectId}:${watch.tag}`, async () => (await this.all(tags)).find((t) => t["name"] === watch.tag)?.["id"], `태그를 찾지 못했다: ${watch.tag}`);
    let query = `tagIds=${encodeURIComponent(tagId)}&postWorkflowClasses=registered,working&order=createdAt`;
    if (watch.scope === "assigned_to_me") {
      const me = await this.id("me", async () => z.object({ id: z.string() }).parse(await this.request("/common/v1/members/me")).id, "내 계정을 찾지 못했다");
      query += `&toMemberIds=${encodeURIComponent(me)}`;
    }
    const items = await this.all(`/project/v1/projects/${encodeURIComponent(projectId)}/posts?${query}`);
    return items.flatMap((p) => (typeof p["id"] === "string" && typeof p["taskNumber"] === "string" ? [{ ticket: p["taskNumber"], postId: p["id"] }] : []));
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
