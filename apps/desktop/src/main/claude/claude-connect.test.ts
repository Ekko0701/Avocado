import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeConnectService } from "./claude-connect";

describe("Claude 연결 상태", () => {
  it("소켓에 붙은 avocado CLI 는 연결된 Claude 로 세지 않는다", () => {
    const home = mkdtempSync(join(tmpdir(), "qa-claude-connect-"));
    try {
      const at = "2026-11-19T00:00:00.000Z";
      const service = new ClaudeConnectService({
        home,
        host: {
          status: () => ({
            listening: true,
            socketPath: join(home, "avocado.sock"),
            error: null,
            clients: [
              { name: "avocado-cli", version: "0.1.0", connectedAt: at },
              { name: "claude-ai", version: "1.2", connectedAt: at },
            ],
          }),
        },
      });
      expect(service.status().clients).toEqual([{ name: "claude-ai", version: "1.2", connectedAt: at }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
