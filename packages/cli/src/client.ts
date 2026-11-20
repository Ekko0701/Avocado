import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AVOCADO_CLI_CLIENT_NAME } from "@qa/shared";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

export const CLI_NAME = AVOCADO_CLI_CLIENT_NAME;
export const CLI_VERSION = "0.1.0";

/** 앱에 붙지 못했거나 도중에 끊겼다(종료 코드 3) */
export class AppConnectionError extends Error {}

/**
 * 앱 소켓 경로. AVOCADO_SOCKET 이 있으면 그것, 개발 실행처럼 QA_USER_DATA_DIR 로 띄운 앱이면 그 폴더의 소켓,
 * 아니면 설치한 앱의 앱 데이터(~/Library/Application Support/Avocado)
 */
export function socketPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (env["AVOCADO_SOCKET"]) return env["AVOCADO_SOCKET"];
  const dataDir = env["QA_USER_DATA_DIR"] || join(home, "Library", "Application Support", "Avocado");
  return join(dataDir, "mcp", "avocado.sock");
}

/** 유닉스 소켓 위의 MCP 전송. nc 를 거치지 않고 node:net 으로 바로 붙는다(docs/poc/cli.md 의 탐침 모양) */
class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private socket: Socket | null = null;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly path: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.path);
      this.socket = socket;
      let connected = false;
      socket.once("connect", () => {
        connected = true;
        resolve();
      });
      socket.on("error", (e) => {
        if (!connected) reject(e);
        else this.onerror?.(e);
      });
      socket.on("data", (chunk) => {
        this.buffer.append(chunk);
        try {
          for (let m = this.buffer.readMessage(); m !== null; m = this.buffer.readMessage()) this.onmessage?.(m);
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("close", () => this.onclose?.());
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new AppConnectionError("앱과의 연결이 끊겼다"));
        return;
      }
      this.socket.write(serializeMessage(message), (e) => (e ? reject(e) : resolve()));
    });
  }

  close(): Promise<void> {
    this.socket?.end();
    return Promise.resolve();
  }
}

export interface ToolReply {
  isError: boolean;
  /** 결과 글자를 JSON 으로 읽은 값. JSON 이 아니면(입력 형식 오류 등) 글자 그대로 */
  value: unknown;
}

export interface AppClient {
  appVersion: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolReply>;
  close(): Promise<void>;
}

const NOT_RUNNING = "Avocado 앱에 연결하지 못했다. 앱을 켜고 다시 실행한다";

/** 앱의 MCP 소켓에 붙는다. 앱이 꺼져 있으면 AppConnectionError */
export async function connectApp(path: string): Promise<AppClient> {
  const client = new Client({ name: CLI_NAME, version: CLI_VERSION });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  try {
    await client.connect(new SocketTransport(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new AppConnectionError(code === "ENOENT" || code === "ECONNREFUSED" ? `${NOT_RUNNING} (${path})` : `${NOT_RUNNING}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    appVersion: client.getServerVersion()?.version ?? "?",
    async call(name, args) {
      if (closed) throw new AppConnectionError("앱과의 연결이 끊겼다. 앱이 꺼졌는지 확인한다");
      let result: Awaited<ReturnType<typeof client.callTool>>;
      try {
        // runs_status 는 45초까지 기다린다. 요청 제한을 그보다 넉넉히 둔다
        result = await client.callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
      } catch (error) {
        if (closed || error instanceof AppConnectionError) throw new AppConnectionError("앱과의 연결이 끊겼다. 앱이 꺼졌는지 확인한다");
        throw error;
      }
      const content = Array.isArray(result["content"]) ? (result["content"] as { type?: string; text?: string }[]) : [];
      const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // 입력 형식 오류처럼 JSON 이 아닌 글자 결과는 그대로 보인다
      }
      return { isError: result["isError"] === true, value };
    },
    close: () => client.close(),
  };
}
