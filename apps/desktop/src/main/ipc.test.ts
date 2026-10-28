import { ipcChannels, type IpcHandlers } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { IpcError, registerIpcHandlers, type IpcMainLike } from "./ipc";

type Listener = Parameters<IpcMainLike["handle"]>[1];

function fakeIpcMain() {
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      listeners.set(channel, listener);
    },
  };
  const call = (channel: string, url: string | null, input: unknown) => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`등록되지 않은 채널: ${channel}`);
    return Promise.resolve(listener({ senderFrame: url === null ? null : { url } }, input));
  };
  return { ipcMain, listeners, call };
}

const TRUSTED = "file:///app/out/renderer/index.html";

const handlers: IpcHandlers = {
  "app:getInfo": () => ({
    name: "Avocado",
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    versions: { electron: "44.6.0", chrome: "152", node: "24.21.0" },
  }),
  "app:ping": ({ message }) => ({ message, receivedAt: "2026-10-21T00:00:00.000Z" }),
  "settings:get": () => {
    throw new Error("not used");
  },
  "settings:update": () => {
    throw new Error("not used");
  },
  "secrets:list": () => {
    throw new Error("not used");
  },
  "secrets:set": () => {
    throw new Error("not used");
  },
  "secrets:delete": () => {
    throw new Error("not used");
  },
  "db:status": () => {
    throw new Error("not used");
  },  "setup:check": () => {
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
  "devices:iosOptions": () => {
    throw new Error("not used");
  },
  "devices:deleteIos": () => {
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
  "builds:projectStatus": () => {
    throw new Error("not used");
  },
  "builds:linkProject": () => {
    throw new Error("not used");
  },
  "builds:unlinkProject": () => {
    throw new Error("not used");
  },
  "builds:buildProject": () => {
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
  "workspace:readApp": () => {
    throw new Error("not used");
  },
  "workspace:saveApp": () => {
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
};

function setup(custom: IpcHandlers = handlers) {
  const fake = fakeIpcMain();
  registerIpcHandlers(fake.ipcMain, custom, (url) => url === TRUSTED);
  return fake;
}

describe("registerIpcHandlers", () => {
  it("계약의 모든 채널을 등록한다", () => {
    const { listeners } = setup();
    expect([...listeners.keys()].sort()).toEqual([...ipcChannels].sort());
  });

  it("신뢰하는 프레임의 ping 을 왕복한다", async () => {
    const { call } = setup();
    await expect(call("app:ping", TRUSTED, { message: "hello" })).resolves.toEqual({
      message: "hello",
      receivedAt: "2026-10-21T00:00:00.000Z",
    });
  });

  it("다른 출처나 프레임 없는 호출을 거부한다", async () => {
    const { call } = setup();
    await expect(call("app:ping", "https://evil.example", { message: "x" })).rejects.toMatchObject({
      reason: "untrusted-sender",
    });
    await expect(call("app:ping", null, { message: "x" })).rejects.toBeInstanceOf(IpcError);
  });

  it("잘못된 입력을 거부하고 핸들러를 부르지 않는다", async () => {
    let called = false;
    const { call } = setup({
      ...handlers,
      "app:ping": (input) => {
        called = true;
        return { message: input.message, receivedAt: "2026-10-21T00:00:00.000Z" };
      },
    });
    await expect(call("app:ping", TRUSTED, { message: "" })).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(call("app:ping", TRUSTED, { message: "a", extra: true })).rejects.toMatchObject({
      reason: "invalid-input",
    });
    await expect(call("app:getInfo", TRUSTED, { sneaky: 1 })).rejects.toMatchObject({ reason: "invalid-input" });
    expect(called).toBe(false);
  });

  it("핸들러가 계약과 다른 값을 돌려주면 막는다", async () => {
    const broken = {
      ...handlers,
      "app:ping": () => ({ message: "x", receivedAt: "어제" }),
    } as IpcHandlers;
    const { call } = setup(broken);
    await expect(call("app:ping", TRUSTED, { message: "x" })).rejects.toMatchObject({ reason: "invalid-output" });
  });
});
