import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildFakeToolArchives,
  fakeToolDefinitions,
  FAKE_MAESTRO_VERSION,
  serveFiles,
  type FakeArchives,
  type FileServer,
} from "../../../test-support/fake-tools";
import { SettingsService } from "../settings/settings-service";
import { createTestOnlyCrypto } from "../settings/test-only-crypto";
import { runCommand, type CommandRunner } from "./command";
import { ToolInstaller } from "./installer";
import { createSetupHandlers, SetupNotReadyError } from "./setup-handlers";
import { maestroEnv, SetupService } from "./setup-service";

let archives: FakeArchives;
let server: FileServer;
let dir: string;

beforeAll(async () => {
  archives = buildFakeToolArchives();
  server = await serveFiles({ "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro });
});
afterAll(async () => {
  await server.close();
  rmSync(archives.dir, { recursive: true, force: true });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-setup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 환경 점검 명령만 정상으로 흉내 내고, 나머지(maestro 실행)는 실제로 실행한다. */
const healthyEnvRunner: CommandRunner = async (file, args, options) => {
  const key = [file, ...args].join(" ");
  const fixed: Record<string, string> = {
    "/usr/bin/sw_vers -productVersion": "27.0.1",
    "/usr/bin/uname -m": "arm64",
    "/usr/bin/xcode-select -p": "/Applications/Xcode.app/Contents/Developer",
    "/usr/bin/xcodebuild -version": "Xcode 27.1",
    "/usr/bin/xcodebuild -checkFirstLaunchStatus": "",
    "/usr/bin/xcrun simctl list runtimes -j": JSON.stringify({ runtimes: [{ name: "iOS 27.0", isAvailable: true }] }),
    "/usr/bin/git --version": "git version 2.50.1",
  };
  if (key in fixed) return { code: 0, stdout: fixed[key] ?? "", stderr: "" };
  return runCommand(file, args, options);
};

function setup() {
  const installer = new ToolInstaller({
    toolsDir: join(dir, "tools"),
    tools: fakeToolDefinitions(server.url, archives),
    run: runCommand,
  });
  const service = new SetupService({ installer, run: healthyEnvRunner, env: { HOME: dir } });
  const settings = new SettingsService({ dir, crypto: createTestOnlyCrypto() });
  settings.init();
  return { installer, service, settings, handlers: createSetupHandlers(service, settings) };
}

describe("SetupService", () => {
  it("도구가 없으면 Maestro 확인은 실패로 알린다", async () => {
    const { service } = setup();
    await expect(service.verifyMaestro()).resolves.toMatchObject({ ok: false });
  });

  it("앱이 설치한 JRE 만으로 Maestro 를 실행한다(사용자 PATH 를 쓰지 않는다)", async () => {
    const { service } = setup();
    await service.installTool("jre");
    await service.installTool("maestro");
    await expect(service.verifyMaestro()).resolves.toEqual({
      ok: true,
      version: FAKE_MAESTRO_VERSION,
      detail: "앱이 설치한 Java 런타임으로 실행됨",
    });
  });

  it("Maestro 실행 환경은 앱 JRE 와 시스템 기본 경로만 쓴다", () => {
    const env = maestroEnv("/app/tools/jre/Contents/Home", "/Users/qa");
    expect(env.PATH).toBe("/app/tools/jre/Contents/Home/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.JAVA_HOME).toBe("/app/tools/jre/Contents/Home");
    expect(env.MAESTRO_CLI_NO_ANALYTICS).toBe("true");
  });

  it("필수 점검이 끝나지 않으면 마법사를 완료할 수 없다", async () => {
    const { handlers, settings } = setup();
    await expect(Promise.resolve(handlers["setup:complete"](undefined))).rejects.toBeInstanceOf(SetupNotReadyError);
    expect(settings.getSettings().settings.setup.completedAt).toBeNull();
  });

  it("준비가 끝나면 완료 시각을 저장한다", async () => {
    const { handlers, service, settings } = setup();
    await service.installTool("jre");
    await service.installTool("maestro");
    const report = await service.check();
    expect(report.ready).toBe(true);
    const saved = await handlers["setup:complete"](undefined);
    expect(saved.setup.completedAt).not.toBeNull();
    expect(settings.getSettings().settings.setup.completedAt).toBe(saved.setup.completedAt);
  });
});
