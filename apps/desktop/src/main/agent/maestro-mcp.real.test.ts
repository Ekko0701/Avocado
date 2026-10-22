import { AuditLog, Budget, MAESTRO_POLICY, MODE_LIMITS, McpBridge } from "@qa/agent";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maestroEnv } from "../setup/setup-service";
import { runCommand } from "../setup/command";
import { pngSize } from "@qa/evidence";
import { createSipsShrinker, MAX_IMAGE_SIDE } from "./image";

/**
 * 실제 maestro mcp(앱이 관리하는 Maestro·JRE)를 브리지로 띄워 본다. LLM 호출은 없다.
 * QA_REAL_MAESTRO_MCP=1 QA_MAESTRO_BIN=<…/bin/maestro> QA_JAVA_HOME=<…/Contents/Home> QA_DEVICE_ID=<부팅한 시뮬레이터 UDID>
 */
const real = process.env["QA_REAL_MAESTRO_MCP"] === "1";

describe.skipIf(!real)("실제 maestro mcp 브리지", () => {
  it("허용 목록 도구만 보이고, 화면 데이터는 감싸고, 캡처는 1,000px 이하로 줄인다", async () => {
    const bin = process.env["QA_MAESTRO_BIN"] ?? "";
    const javaHome = process.env["QA_JAVA_HOME"] ?? "";
    const deviceId = process.env["QA_DEVICE_ID"] ?? "";
    const env = { ...maestroEnv(javaHome, homedir()), MAESTRO_DRIVER_STARTUP_TIMEOUT: "90000" };
    const transport = new StdioClientTransport({ command: bin, args: ["mcp", "--no-viewer"], env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)), stderr: "pipe" });
    const dir = mkdtempSync(join(tmpdir(), "qa-real-mcp-"));
    const auditFile = join(dir, "audit.jsonl");
    const bridge = await McpBridge.connect(transport, {
      serverName: "maestro",
      policy: MAESTRO_POLICY.author,
      deviceId,
      env: {},
      budget: new Budget(MODE_LIMITS.author, { monthlyRemainingUsd: 1 }),
      audit: new AuditLog(auditFile, { jobId: "real-mcp", secrets: [] }),
      shrinkImage: createSipsShrinker(runCommand, join(dir, "tmp")),
      callTimeoutMs: 180_000,
    });
    try {
      expect(bridge.available.map((t) => t.name).sort()).toEqual(["cheat_sheet", "inspect_screen", "list_devices", "run", "take_screenshot"]);
      const devices = await bridge.call("list_devices", {});
      expect(JSON.stringify(devices)).toContain(deviceId);
      const screen = await bridge.call("inspect_screen", {});
      expect(typeof screen === "string" && screen.startsWith("<screen_data>")).toBe(true);
      const shot = await bridge.call("take_screenshot", {});
      const image = Array.isArray(shot) ? shot.find((b) => b.type === "image") : undefined;
      expect(image?.type).toBe("image");
      if (image?.type === "image" && image.source.type === "base64") {
        const size = pngSize(Buffer.from(image.source.data, "base64"));
        expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
      }
      // 어떤 모드에도 주지 않는 도구는 서버에 있어도 부를 수 없다
      await expect(bridge.call("run_on_cloud", {})).rejects.toThrow();
      expect(readFileSync(auditFile, "utf8")).toContain('"tool_denied"');
    } finally {
      await bridge.close();
    }
  }, 300_000);
});
