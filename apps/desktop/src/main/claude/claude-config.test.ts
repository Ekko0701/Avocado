import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToClaudeDesktop, ClaudeConfigError, claudeCodeCommand, claudeDesktopConfigPath, desktopState, relayEntry } from "./claude-config";

let home: string;
const SOCKET = "/Users/tester/Library/Application Support/Avocado/mcp/avocado.sock";
const ENTRY = relayEntry(SOCKET);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qa-claude-cfg-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const configPath = () => claudeDesktopConfigPath(home);
const appDir = () => mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });

describe("Claude 앱 등록(ADR 0022)", () => {
  it("릴레이는 셸 없이 macOS 기본 nc 를 인자 배열로 띄운다", () => {
    expect(ENTRY).toEqual({ command: "/usr/bin/nc", args: ["-U", SOCKET] });
  });

  it("데스크톱 앱이 없으면 등록하지 않는다", () => {
    expect(desktopState(configPath(), ENTRY)).toBe("missing_app");
    expect(() => addToClaudeDesktop(configPath(), ENTRY)).toThrow(ClaudeConfigError);
  });

  it("설정 파일이 없으면 새로 만든다(0600)", () => {
    appDir();
    expect(desktopState(configPath(), ENTRY)).toBe("not_configured");
    addToClaudeDesktop(configPath(), ENTRY);
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ mcpServers: { avocado: ENTRY } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${configPath()}.avocado-backup`)).toBe(false);
    expect(desktopState(configPath(), ENTRY)).toBe("configured");
  });

  it("다른 서버·키는 그대로 두고 사본을 남긴다. 다른 명령으로 등록돼 있으면 outdated 로 보고 고친다", () => {
    appDir();
    const original = { globalShortcut: "Cmd+Space", mcpServers: { other: { command: "/bin/other", args: ["x"] }, avocado: { command: "/old/relay", args: [] } } };
    writeFileSync(configPath(), JSON.stringify(original));
    expect(desktopState(configPath(), ENTRY)).toBe("outdated");
    addToClaudeDesktop(configPath(), ENTRY);
    const next = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    expect(next).toEqual({ globalShortcut: "Cmd+Space", mcpServers: { other: { command: "/bin/other", args: ["x"] }, avocado: ENTRY } });
    expect(JSON.parse(readFileSync(`${configPath()}.avocado-backup`, "utf8"))).toEqual(original);
    expect(existsSync(`${configPath()}.avocado-tmp`)).toBe(false);
  });

  it("JSON 이 아닌 설정 파일은 건드리지 않는다", () => {
    appDir();
    writeFileSync(configPath(), "{ 고친 중");
    expect(desktopState(configPath(), ENTRY)).toBe("invalid");
    expect(() => addToClaudeDesktop(configPath(), ENTRY)).toThrow(/JSON 이 아니다/);
    expect(readFileSync(configPath(), "utf8")).toBe("{ 고친 중");
  });

  it("Claude Code 명령은 사용자 범위로 등록하고, 경로의 공백·작은따옴표를 셸에서 안전하게 감싼다", () => {
    expect(claudeCodeCommand(ENTRY)).toBe(
      `claude mcp add-json --scope user avocado '{"type":"stdio","command":"/usr/bin/nc","args":["-U","${SOCKET}"]}'`,
    );
    expect(claudeCodeCommand(relayEntry("/tmp/it's/a.sock"))).toContain(`"/tmp/it'\\''s/a.sock"`);
  });
});
