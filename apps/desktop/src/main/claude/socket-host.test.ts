import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorService, type McpConnection } from "../agent/author-service";
import { JudgeService } from "../agent/judge-service";
import { relayEntry } from "./claude-config";
import { createAvocadoMcpServer, routeMcpPorts, AVOCADO_MCP_INSTRUCTIONS, type AvocadoMcpPort } from "./mcp-server";
import { McpSocketHost } from "./socket-host";

let dir: string;
const hosts: McpSocketHost[] = [];
const clients: Client[] = [];
beforeEach(() => {
  // macOS 소켓 경로 상한(104바이트) 안에 들게 짧은 임시 폴더를 쓴다
  dir = mkdtempSync(join(tmpdir(), "qa-mcp-"));
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  rmSync(dir, { recursive: true, force: true });
});

function host(socketPath = join(dir, "mcp", "avocado.sock")) {
  const calls: { connection: McpConnection; name: string; args: unknown }[] = [];
  const disconnected: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const h = new McpSocketHost({
    socketPath,
    createServer: (connectionId, onInitialized) =>
      createAvocadoMcpServer({
        port: {
          tools: () => [{ name: "attach_author", description: "맡는다", inputSchema: { type: "object", properties: {} } }],
          call: async (connection, name, args) => {
            calls.push({ connection, name, args });
            return { content: [{ type: "text", text: `ok ${name}` }] };
          },
        },
        version: "0.1.0",
        connectionId,
        onInitialized,
      }),
    onDisconnect: (id) => disconnected.push(id),
    log: (entry) => logs.push(entry),
  });
  hosts.push(h);
  return { h, calls, disconnected, logs, socketPath };
}

/** Claude 앱이 하는 그대로: 등록한 명령(/usr/bin/nc -U <소켓>)을 stdio 서버로 띄운다 */
async function connectLikeClaude(socketPath: string, name = "claude-code"): Promise<Client> {
  const entry = relayEntry(socketPath);
  const client = new Client({ name, version: "9.9.9" });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, stderr: "pipe" }));
  clients.push(client);
  return client;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
}

describe("McpSocketHost (실제 유닉스 소켓 + /usr/bin/nc 릴레이)", () => {
  it("Claude 앱이 nc 로 붙어 도구 목록·호출을 쓰고, 연결 이름이 상태에 보인다. 끊기면 알린다", async () => {
    const { h, calls, disconnected, socketPath } = host();
    await h.start();
    expect(h.status()).toMatchObject({ listening: true, error: null, clients: [] });
    // 같은 사용자만: 폴더 0700, 소켓 0600
    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const client = await connectLikeClaude(socketPath);
    expect(client.getInstructions()).toBe(AVOCADO_MCP_INSTRUCTIONS);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["attach_author"]);
    const result = await client.callTool({ name: "attach_author", arguments: { jobId: "job-1" } });
    expect(result.content).toEqual([{ type: "text", text: "ok attach_author" }]);
    expect(calls[0]).toMatchObject({ name: "attach_author", args: { jobId: "job-1" }, connection: { client: "claude-code 9.9.9" } });
    await until(() => h.status().clients.length === 1);
    expect(h.status().clients[0]).toMatchObject({ name: "claude-code", version: "9.9.9" });

    await client.close();
    clients.splice(clients.indexOf(client), 1);
    await until(() => disconnected.length === 1);
    expect(disconnected[0]).toBe(calls[0]?.connection.id);
    expect(h.status().clients).toEqual([]);
  });

  it("연결마다 따로 세션을 둔다(두 Claude 대화)", async () => {
    const { h, calls, socketPath } = host();
    await h.start();
    const a = await connectLikeClaude(socketPath, "claude-ai");
    const b = await connectLikeClaude(socketPath, "claude-code");
    await a.callTool({ name: "attach_author", arguments: {} });
    await b.callTool({ name: "attach_author", arguments: {} });
    expect(calls[0]?.connection.id).not.toBe(calls[1]?.connection.id);
    expect(calls.map((c) => c.connection.client)).toEqual(["claude-ai 9.9.9", "claude-code 9.9.9"]);
  });

  it("지난 실행이 남긴 소켓 파일은 지우고 열고, 다른 Avocado 가 쓰는 소켓은 빼앗지 않는다", async () => {
    const socketPath = join(dir, "mcp", "avocado.sock");
    mkdirSync(dirname(socketPath), { recursive: true });
    writeFileSync(socketPath, "");
    const first = host(socketPath);
    await first.h.start();
    expect(first.h.status().listening).toBe(true);

    const second = host(socketPath);
    await second.h.start();
    expect(second.h.status()).toMatchObject({ listening: false, error: expect.stringContaining("다른 Avocado") });
    // 첫 번째는 그대로 쓸 수 있다
    await connectLikeClaude(socketPath);
  });

  it("소켓 경로가 macOS 상한보다 길면 열지 않고 이유를 알린다", async () => {
    const { h } = host(join(dir, "x".repeat(120), "avocado.sock"));
    await h.start();
    expect(h.status()).toMatchObject({ listening: false, error: expect.stringContaining("너무 길다") });
  });
});

describe("routeMcpPorts (플로우 만들기·화면 판정을 한 서버로)", () => {
  const conn: McpConnection = { id: "c", client: "claude-code 1" };
  const port = (name: string, reply: string): AvocadoMcpPort => ({
    tools: () => [{ name, description: "", inputSchema: { type: "object" } }],
    call: async () => ({ content: [{ type: "text", text: reply }] }),
  });

  it("도구 이름으로 맡은 서비스에 보내고, 모르는 도구는 오류 결과로, 이름이 겹치면 만들 때 막는다", async () => {
    const routed = routeMcpPorts([port("a1", "A"), port("b1", "B")]);
    expect(routed.tools().map((t) => t.name)).toEqual(["a1", "b1"]);
    expect(await routed.call(conn, "b1", {})).toEqual({ content: [{ type: "text", text: "B" }] });
    expect(await routed.call(conn, "zz", {})).toMatchObject({ isError: true });
    expect(() => routeMcpPorts([port("a1", "A"), port("a1", "B")])).toThrow("겹친다");
  });

  it("앱의 실제 도구(플로우 만들기 + 화면 판정)는 이름이 겹치지 않는다", () => {
    const noop = async () => ({ content: [] });
    const routed = routeMcpPorts([
      { tools: () => AuthorService.mcpTools(), call: noop },
      { tools: () => JudgeService.mcpTools(), call: noop },
    ]);
    expect(routed.tools().map((t) => t.name)).toEqual(expect.arrayContaining(["attach_author", "submit_flow", "attach_judge", "submit_judgement"]));
  });
});
