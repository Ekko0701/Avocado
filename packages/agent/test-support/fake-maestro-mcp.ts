/**
 * 테스트용 가짜 maestro mcp 서버. 실제 서버(Maestro 2.11.0)와 같은 도구 이름·인자를 쓴다.
 * - 메모리 안에서: createFakeMaestroServer() 를 InMemoryTransport 에 연결
 * - 자식 프로세스로: `node fake-maestro-mcp.ts` (Node 24 타입 제거 실행, stdio)
 * 받은 호출은 calls 에 남기고, run 결과에는 받은 env 값을 그대로 돌려줘 가림을 확인하게 한다.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

/** 1x1 투명 PNG */
export const FAKE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface FakeServerOptions {
  /** inspect_screen 이 돌려줄 화면 글자 */
  screenText?: string;
}

export function createFakeMaestroServer(options: FakeServerOptions = {}): { server: McpServer; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const server = new McpServer({ name: "fake-maestro", version: "0.0.0" });
  const record = (tool: string, args: Record<string, unknown>): void => {
    calls.push({ tool, args });
  };

  server.registerTool("list_devices", { description: "List devices" }, () => {
    record("list_devices", {});
    return { content: [{ type: "text", text: JSON.stringify([{ device_id: "SIM-1", platform: "ios" }]) }] };
  });
  server.registerTool("inspect_screen", { description: "Inspect the view hierarchy", inputSchema: { device_id: z.string() } }, (args) => {
    record("inspect_screen", args);
    return { content: [{ type: "text", text: options.screenText ?? "text: 로그인\nid: login_button" }] };
  });
  server.registerTool("take_screenshot", { description: "Take a screenshot", inputSchema: { device_id: z.string() } }, (args) => {
    record("take_screenshot", args);
    return { content: [{ type: "image", data: FAKE_PNG_BASE64, mimeType: "image/png" }] };
  });
  server.registerTool(
    "run",
    {
      description: "Run Maestro commands",
      inputSchema: {
        device_id: z.string(),
        yaml: z.string().optional(),
        files: z.array(z.string()).optional(),
        dir: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      },
    },
    (args) => {
      record("run", args);
      const failed = (args.yaml ?? "").includes("FAIL");
      return { content: [{ type: "text", text: `ran on ${args.device_id} env=${JSON.stringify(args.env ?? {})}` }], isError: failed };
    },
  );
  server.registerTool("cheat_sheet", { description: "Maestro cheat sheet" }, () => {
    record("cheat_sheet", {});
    return { content: [{ type: "text", text: "- tapOn: <text or id>" }] };
  });
  // 허용 목록 밖이어야 하는 도구들
  server.registerTool("run_on_cloud", { description: "Upload and run on Maestro Cloud", inputSchema: { app_file: z.string() } }, (args) => {
    record("run_on_cloud", args);
    return { content: [{ type: "text", text: "uploaded" }] };
  });
  server.registerTool("open_maestro_viewer", { description: "Open the viewer" }, () => {
    record("open_maestro_viewer", {});
    return { content: [{ type: "text", text: "opened" }] };
  });
  return { server, calls };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const { server } = createFakeMaestroServer({ screenText: process.env["FAKE_SCREEN_TEXT"] });
  await server.connect(new StdioServerTransport());
}
