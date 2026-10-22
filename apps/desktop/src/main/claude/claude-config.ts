import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Claude 앱에 등록하는 MCP 서버 이름 */
export const CLAUDE_SERVER_NAME = "avocado";

export interface McpServerEntry {
  command: string;
  args: string[];
}

export class ClaudeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeConfigError";
  }
}

/** Claude 앱이 띄우는 stdio 서버: macOS 기본 nc 로 앱의 소켓에 잇는다(셸 없이 인자 배열, ADR 0022) */
export function relayEntry(socketPath: string): McpServerEntry {
  return { command: "/usr/bin/nc", args: ["-U", socketPath] };
}

export function claudeDesktopConfigPath(home: string): string {
  return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

/** 데스크톱 앱 설정 중 쓰는 부분. 나머지 키는 그대로 둔다 */
const DesktopConfigSchema = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() });
const EntrySchema = z.looseObject({ command: z.string(), args: z.array(z.string()).optional() });

export type DesktopState = "missing_app" | "not_configured" | "configured" | "outdated" | "invalid";

export function desktopState(configPath: string, entry: McpServerEntry): DesktopState {
  if (!existsSync(dirname(configPath))) return "missing_app";
  if (!existsSync(configPath)) return "not_configured";
  const config = readConfig(configPath);
  if (!config) return "invalid";
  const registered = config.mcpServers?.[CLAUDE_SERVER_NAME];
  if (registered === undefined) return "not_configured";
  const current = EntrySchema.safeParse(registered);
  if (!current.success) return "outdated";
  return current.data.command === entry.command && JSON.stringify(current.data.args ?? []) === JSON.stringify(entry.args) ? "configured" : "outdated";
}

/**
 * Claude 데스크톱 앱 설정에 Avocado 를 등록한다. 다른 서버·키는 그대로 두고, 바꾸기 전 사본(.avocado-backup)을 남긴다.
 * 파일이 JSON 이 아니면 건드리지 않는다(사용자가 고친 설정을 덮어쓰지 않게).
 */
export function addToClaudeDesktop(configPath: string, entry: McpServerEntry): void {
  const state = desktopState(configPath, entry);
  if (state === "missing_app") throw new ClaudeConfigError("Claude 데스크톱 앱 설정 폴더가 없다. 앱을 설치하고 한 번 연 뒤 다시 시도한다");
  if (state === "invalid") throw new ClaudeConfigError(`Claude 데스크톱 앱 설정 파일을 읽지 못했다(JSON 이 아니다). 파일을 고친 뒤 다시 시도한다: ${configPath}`);
  const exists = existsSync(configPath);
  const config = exists ? readConfig(configPath) : {};
  if (!config) throw new ClaudeConfigError(`Claude 데스크톱 앱 설정 파일을 읽지 못했다: ${configPath}`);
  if (exists) copyFileSync(configPath, `${configPath}.avocado-backup`);
  const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [CLAUDE_SERVER_NAME]: entry } };
  // 쓰다가 끊겨도 원래 파일이 반쯤 남지 않게 임시 파일에 쓰고 바꾼다
  const tmp = `${configPath}.avocado-tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
}

/** Claude Code 에 등록하는 명령(사용자가 터미널에서 실행). 앱은 claude 를 실행하지 않는다 */
export function claudeCodeCommand(entry: McpServerEntry): string {
  const json = JSON.stringify({ type: "stdio", command: entry.command, args: entry.args });
  return `claude mcp add-json --scope user ${CLAUDE_SERVER_NAME} '${json.replaceAll("'", "'\\''")}'`;
}

function readConfig(configPath: string): z.infer<typeof DesktopConfigSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // JSON 이 아니다: 호출한 쪽이 invalid 로 알린다
    return null;
  }
  const parsed = DesktopConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
