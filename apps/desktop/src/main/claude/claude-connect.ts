import type { ClaudeConnection } from "@qa/shared";
import { addToClaudeDesktop, claudeCodeCommand, claudeDesktopConfigPath, desktopState, relayEntry } from "./claude-config";
import type { McpSocketHostStatus } from "./socket-host";

/** 설정 화면의 "Claude 연결"(ADR 0022): 소켓 상태와 Claude 앱 등록 */
export class ClaudeConnectService {
  constructor(private readonly options: { host: { status(): McpSocketHostStatus }; home: string }) {}

  status(): ClaudeConnection {
    const host = this.options.host.status();
    const entry = relayEntry(host.socketPath);
    const configPath = claudeDesktopConfigPath(this.options.home);
    return {
      listening: host.listening,
      socketPath: host.socketPath,
      error: host.error,
      clients: host.clients,
      desktop: { configPath, state: desktopState(configPath, entry) },
      codeCommand: claudeCodeCommand(entry),
    };
  }

  connectDesktop(): ClaudeConnection {
    const { socketPath } = this.options.host.status();
    addToClaudeDesktop(claudeDesktopConfigPath(this.options.home), relayEntry(socketPath));
    return this.status();
  }
}
