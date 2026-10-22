/**
 * 테스트용 가짜 Messages API(POST /v1/messages). 실제 API 를 부르지 않고 SDK 도구 실행기를 끝까지 돌려 보게 한다.
 * 응답은 순서대로 준비한 함수가 요청 본문을 보고 만든다.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeReply = (body: FakeRequestBody) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface FakeRequestBody {
  model: string;
  system?: unknown;
  messages: { role: string; content: unknown }[];
  tools?: { name: string; input_schema?: unknown }[];
  output_config?: { effort?: string };
  thinking?: unknown;
  [key: string]: unknown;
}

export interface FakeMessagesApi {
  url: string;
  requests: FakeRequestBody[];
  /** 요청마다 anthropic-beta 헤더 */
  betas: string[];
  close(): Promise<void>;
}

export interface FakeUsage {
  input: number;
  output: number;
  cacheRead?: number;
  /** 5분 TTL 캐시 쓰기 */
  cacheWrite?: number;
}

export function message(content: Record<string, unknown>[], stopReason: string, usage: FakeUsage = { input: 1000, output: 100 }): Record<string, unknown> {
  return {
    id: `msg_fake_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation_input_tokens: usage.cacheWrite ?? 0,
      cache_creation: { ephemeral_5m_input_tokens: usage.cacheWrite ?? 0, ephemeral_1h_input_tokens: 0 },
    },
  };
}

export function toolUse(name: string, input: Record<string, unknown>, usage?: FakeUsage): Record<string, unknown> {
  return message([{ type: "tool_use", id: `toolu_fake_${Math.random().toString(36).slice(2, 10)}`, name, input }], "tool_use", usage);
}

export async function startFakeMessagesApi(replies: FakeReply[]): Promise<FakeMessagesApi> {
  const requests: FakeRequestBody[] = [];
  const betas: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeRequestBody;
      requests.push(body);
      betas.push(String(req.headers["anthropic-beta"] ?? ""));
      const reply = replies[requests.length - 1];
      if (!reply) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "준비한 응답이 없다" } }));
        return;
      }
      Promise.resolve(reply(body)).then(
        (out) => {
          if (!res.writableEnded && !res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        },
        () => res.destroy(),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    betas,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // SDK 의 keep-alive·진행 중 연결이 남아 있으면 close 가 끝나지 않는다
        server.closeAllConnections();
      }),
  };
}
