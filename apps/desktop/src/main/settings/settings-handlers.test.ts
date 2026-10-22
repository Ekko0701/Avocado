import { ipcChannels, type IpcHandlers } from "@qa/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerIpcHandlers, type IpcMainLike } from "../ipc";
import { createSettingsHandlers } from "./settings-handlers";
import { SettingsService } from "./settings-service";
import { createTestOnlyCrypto } from "./test-only-crypto";

const SECRET = "ghp_THIS_TOKEN_MUST_STAY_IN_MAIN_9876";
const TRUSTED = "file:///app/out/renderer/index.html";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-settings-ipc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const service = new SettingsService({ dir, crypto: createTestOnlyCrypto() });
  service.init();
  const listeners = new Map<string, Parameters<IpcMainLike["handle"]>[1]>();
  const handlers = {
    "app:getInfo": () => {
      throw new Error("not used");
    },
    "app:ping": () => {
      throw new Error("not used");
    },
    "db:status": () => {
      throw new Error("not used");
    },
    "setup:check": () => {
      throw new Error("not used");
    },
    "setup:installTool": () => {
      throw new Error("not used");
    },
    "setup:progress": () => {
      throw new Error("not used");
    },
    "setup:verifyMaestro": () => {
      throw new Error("not used");
    },
    "devices:list": () => {
      throw new Error("not used");
    },
    "devices:prepareIos": () => {
      throw new Error("not used");
    },
    "devices:prepareAndroid": () => {
      throw new Error("not used");
    },
    "devices:shutdown": () => {
      throw new Error("not used");
    },
    "builds:list": () => {
      throw new Error("not used");
    },
    "builds:pickAndRegister": () => {
      throw new Error("not used");
    },
    "builds:runScript": () => {
      throw new Error("not used");
    },
    "builds:install": () => {
      throw new Error("not used");
    },
    "runs:pickFlow": () => {
      throw new Error("not used");
    },
    "runs:start": () => {
      throw new Error("not used");
    },
    "runs:list": () => {
      throw new Error("not used");
    },
    "runs:get": () => {
      throw new Error("not used");
    },
    "runs:cancel": () => {
      throw new Error("not used");
    },
    "evidence:list": () => {
      throw new Error("not used");
    },
    "evidence:file": () => {
      throw new Error("not used");
    },
    "evidence:search": () => {
      throw new Error("not used");
    },
    "evidence:hierarchy": () => {
      throw new Error("not used");
    },
    "remote:verify": () => {
      throw new Error("not used");
    },
    "workspace:status": () => {
      throw new Error("not used");
    },
    "workspace:connect": () => {
      throw new Error("not used");
    },
    "workspace:sync": () => {
      throw new Error("not used");
    },
    "workspace:testcases": () => {
      throw new Error("not used");
    },
    "workspace:readTestcase": () => {
      throw new Error("not used");
    },
    "workspace:saveTestcase": () => {
      throw new Error("not used");
    },
    "workspace:requestReview": () => {
      throw new Error("not used");
    },
    "workspace:branches": () => {
      throw new Error("not used");
    },
    "workspace:checkout": () => {
      throw new Error("not used");
    },
    "workspace:history": () => {
      throw new Error("not used");
    },
    "agent:usage": () => {
      throw new Error("not used");
    },
    "agent:currentAuthor": () => {
      throw new Error("not used");
    },
    "workspace:myPulls": () => {
      throw new Error("not used");
    },
    "runs:startFromWorkspace": () => {
      throw new Error("not used");
    },
    "runs:queue": () => {
      throw new Error("not used");
    },
    "runs:clearQueue": () => {
      throw new Error("not used");
    },
    "runs:setKeep": () => {
      throw new Error("not used");
    },
    "update:status": () => {
      throw new Error("not used");
    },
    "update:check": () => {
      throw new Error("not used");
    },
    "update:download": () => {
      throw new Error("not used");
    },
    "agent:judge": () => {
      throw new Error("not used");
    },
    "agent:judgements": () => {
      throw new Error("not used");
    },
    "app:openExternal": () => {
      throw new Error("not used");
    },
    "evidence:prepareUpload": () => {
      throw new Error("not used");
    },
    "evidence:upload": () => {
      throw new Error("not used");
    },
    "evidence:uploads": () => {
      throw new Error("not used");
    },
    "agent:startAuthor": () => {
      throw new Error("not used");
    },
    "agent:authorStatus": () => {
      throw new Error("not used");
    },
    "agent:cancel": () => {
      throw new Error("not used");
    },
    "agent:startClaudeJudge": () => {
      throw new Error("not used");
    },
    "agent:claudeJudgeStatus": () => {
      throw new Error("not used");
    },
    "agent:cancelClaudeJudge": () => {
      throw new Error("not used");
    },
    "workspace:accounts": () => {
      throw new Error("not used");
    },
    "remote:repos": () => {
      throw new Error("not used");
    },
    "claude:status": () => {
      throw new Error("not used");
    },
    "claude:connectDesktop": () => {
      throw new Error("not used");
    },
    "setup:complete": () => {
      throw new Error("not used");
    },
    ...createSettingsHandlers(service),
  } satisfies IpcHandlers;
  registerIpcHandlers({ handle: (c, l) => listeners.set(c, l) }, handlers, (url) => url === TRUSTED);
  const call = (channel: string, input: unknown) =>
    Promise.resolve(listeners.get(channel)?.({ senderFrame: { url: TRUSTED } }, input));
  return { service, call };
}

describe("설정 IPC", () => {
  it("비밀을 저장해도 어떤 IPC 응답에도 값이 없다", async () => {
    const { call, service } = setup();
    const outputs = [
      await call("secrets:set", { name: "githubToken", value: SECRET }),
      await call("secrets:list", undefined),
      await call("settings:get", undefined),
      await call("settings:update", { agent: { judgeSampleRate: 0.5 } }),
      await call("secrets:delete", { name: "githubToken" }),
    ];
    expect(JSON.stringify(outputs)).not.toContain(SECRET);
    expect(service.getSecret("githubToken")).toBeNull();
  });

  it("값을 읽는 채널은 계약에 없다", () => {
    expect(ipcChannels.filter((c) => c.startsWith("secrets:")).sort()).toEqual([
      "secrets:delete",
      "secrets:list",
      "secrets:set",
    ]);
  });

  it("잘못된 비밀 이름·설정 패치는 IPC 단계에서 거부한다", async () => {
    const { call } = setup();
    await expect(call("secrets:set", { name: "../../etc/passwd", value: "x" })).rejects.toMatchObject({
      reason: "invalid-input",
    });
    await expect(call("settings:update", { evidence: { retentionDays: -1 } })).rejects.toMatchObject({
      reason: "invalid-input",
    });
  });
});
