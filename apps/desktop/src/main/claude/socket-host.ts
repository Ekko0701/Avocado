import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname } from "node:path";

/** macOS 유닉스 소켓 경로 상한(sun_path 104바이트, 끝 NUL 포함) */
const MAX_SOCKET_PATH_BYTES = 103;

export interface McpClientInfo {
  name: string;
  version: string;
  connectedAt: string;
}

export interface McpSocketHostStatus {
  listening: boolean;
  socketPath: string;
  error: string | null;
  clients: McpClientInfo[];
}

export interface McpSocketHostOptions {
  socketPath: string;
  /** 연결마다 MCP 서버를 하나 만든다. initialize 가 끝나면 onInitialized 로 Claude 앱 이름을 알린다 */
  createServer(connectionId: string, onInitialized: (client: { name: string; version: string }) => void): Server;
  onDisconnect(connectionId: string): void;
  /** JSON 한 줄 기록(키·화면 데이터 없음) */
  log(entry: Record<string, unknown>): void;
  now?: () => Date;
}

/**
 * 사용자의 Claude 앱이 붙는 로컬 MCP 소켓(ADR 0022). Claude 앱은 `/usr/bin/nc -U <소켓>` 을 stdio 서버로 띄워 이 소켓에 잇는다.
 * 소켓은 0700 폴더 안에 두어 같은 사용자 계정의 프로세스만 연결할 수 있다.
 */
export class McpSocketHost {
  private server: NetServer | null = null;
  private readonly sockets = new Map<string, Socket>();
  private readonly clients = new Map<string, McpClientInfo>();
  private error: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: McpSocketHostOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** 소켓을 연다. 실패하면 던지지 않고 status().error 로 알린다(앱의 다른 기능은 계속 쓴다) */
  async start(): Promise<void> {
    const { socketPath } = this.options;
    try {
      if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`소켓 경로가 너무 길다(${Buffer.byteLength(socketPath)}바이트): ${socketPath}`);
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(socketPath), 0o700);
      if (existsSync(socketPath)) {
        if (await canConnect(socketPath)) throw new Error("다른 Avocado 가 Claude 연결을 쓰고 있다. 그 앱을 닫고 이 앱을 다시 켠다");
        // 지난 실행이 남긴 소켓 파일
        unlinkSync(socketPath);
      }
      const server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", (e) => this.options.log({ event: "mcp_socket_error", message: e.message }));
      chmodSync(socketPath, 0o600);
      this.server = server;
      this.error = null;
      this.options.log({ event: "mcp_listening", socketPath });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.options.log({ event: "mcp_listen_failed", message: this.error });
    }
  }

  status(): McpSocketHostStatus {
    return { listening: this.server !== null, socketPath: this.options.socketPath, error: this.error, clients: [...this.clients.values()] };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.values()) socket.destroy();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 다른 Avocado 가 쓰는 소켓은 지우지 않는다(이 앱이 연 것만)
    if (existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
  }

  private accept(socket: Socket): void {
    const id = randomUUID();
    this.sockets.set(id, socket);
    const server = this.options.createServer(id, (client) => {
      this.clients.set(id, { ...client, connectedAt: this.now().toISOString() });
      this.options.log({ event: "mcp_client", connectionId: id, client: client.name, version: client.version });
    });
    socket.on("error", (e) => this.options.log({ event: "mcp_connection_error", connectionId: id, message: e.message }));
    socket.once("close", () => {
      this.sockets.delete(id);
      this.clients.delete(id);
      this.options.onDisconnect(id);
      this.options.log({ event: "mcp_disconnect", connectionId: id });
      server.close().catch((e: unknown) => this.options.log({ event: "mcp_close_error", connectionId: id, message: e instanceof Error ? e.message : String(e) }));
    });
    // MCP stdio 형식(JSON 한 줄씩)을 소켓 위에서 그대로 쓴다
    server.connect(new StdioServerTransport(socket, socket)).catch((e: unknown) => {
      this.options.log({ event: "mcp_connect_error", connectionId: id, message: e instanceof Error ? e.message : String(e) });
      socket.destroy();
    });
  }
}

/** 소켓에 누가 듣고 있는지(다른 Avocado) 본다 */
function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
