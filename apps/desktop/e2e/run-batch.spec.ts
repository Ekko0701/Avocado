import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import type { RunBatch, RunOptions } from "@qa/shared";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FAKE_AVD, buildFakeAndroidSdk, buildFakeToolArchives, fakeToolDefinitions, serveFiles, type FakeArchives, type FileServer } from "../test-support/fake-tools";
import { launchApp } from "./launch";

// T-120(ADR 0035): 밖에서 붙은 MCP 클라이언트가 start_runs 로 실행 묶음을 시작하면 열려 있던 실행 화면에 진행이 보이고 결과 화면에 실행이 생긴다.
// 기기는 가짜 Android SDK(실행 중인 에뮬레이터 하나), Maestro 는 실제 산출물 픽스처를 내는 가짜다. 워크스페이스는 로컬 워크스페이스(ADR 0036)

type ToolText = { content: { type: string; text?: string }[]; isError?: boolean };
const json = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]?.text ?? "null");

let archives: FakeArchives;
let server: FileServer;
let toolsFile: string;
let sdk: ReturnType<typeof buildFakeAndroidSdk>;

test.beforeAll(async () => {
  archives = buildFakeToolArchives();
  server = await serveFiles({ "jre.tar.gz": archives.jre, "maestro.zip": archives.maestro });
  toolsFile = join(archives.dir, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(fakeToolDefinitions(server.url, archives)));
  sdk = buildFakeAndroidSdk();
});

test.afterAll(async () => {
  await server.close();
  rmSync(archives.dir, { recursive: true, force: true });
  rmSync(sdk.dir, { recursive: true, force: true });
});

const testcase = (id: string, title: string) => `---
id: ${id}
title: ${title}
app: demo
targets: [android]
priority: high
tags: [smoke]
status: active
---
## 스텝
1. 앱을 연다
   - 기대: 첫 화면이 보인다
`;
const flow = (id: string, extra = "") => `appId: \${APP_ID}
name: ${id} 첫 화면
tags: [${id}, smoke]
---
- launchApp
${extra}`;

/** 로컬 워크스페이스(앱 데이터의 local-workspace, git 저장소)를 미리 만든다: 통과·플로우 없음·실패 TC */
function seedLocalWorkspace(userDataDir: string) {
  const dir = join(userDataDir, "local-workspace");
  const files: Record<string, string> = {
    "workspace.yaml": "schemaVersion: 2\nname: e2e\napps: [demo]\ndefaults:\n  locale: ko_KR\n",
    "apps/demo/app.yaml": "name: Demo\nlocale: ko_KR\ntargets:\n  android:\n    appId: com.example.demo\n",
    "apps/demo/accounts.yaml": "signup:\n  description: 가입 비밀번호\n  keys: [DEMO_TEST_PASSWORD]\n",
    "apps/demo/testcases/TC-0101.md": testcase("TC-0101", "첫 화면이 열린다"),
    "apps/demo/testcases/TC-0102.md": testcase("TC-0102", "플로우가 아직 없다"),
    "apps/demo/testcases/TC-0103.md": testcase("TC-0103", "실패하는 플로우"),
    "apps/demo/flows/android/TC-0101.yaml": flow("TC-0101"),
    "apps/demo/flows/android/TC-0103.yaml": flow("TC-0103", "# AVOCADO_E2E_FAIL\n"),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@avocado.local", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "seed");
}

test("밖의 MCP 클라이언트가 실행 묶음을 시작하면 실행·결과 화면에 보이고, 묶음 id 로만 조회·취소한다 (T-120)", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-e2e-userdata-"));
  seedLocalWorkspace(userDataDir);
  const { app, page } = await launchApp({ userDataDir, toolsFile, workspaceSource: "local", env: { ANDROID_HOME: sdk.dir } });
  const client = new Client({ name: "avocado-e2e-cli", version: "1.0" });
  try {
    await page.evaluate(async () => {
      await window.qa.setup.installTool({ tool: "jre" });
      await window.qa.setup.installTool({ tool: "maestro" });
    });
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "실행", exact: true }).click();

    await client.connect(new StdioClientTransport({ command: "/usr/bin/nc", args: ["-U", join(userDataDir, "mcp", "avocado.sock")], stderr: "pipe" }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["run_options", "start_runs", "runs_status", "cancel_runs"]));

    const options = json(await client.callTool({ name: "run_options", arguments: {} })) as RunOptions;
    expect(options.workspaceConnected).toBe(true);
    expect(options.apps).toEqual([
      {
        app: "demo",
        testcases: [
          { id: "TC-0101", title: "첫 화면이 열린다", tags: ["smoke"], status: "active", flows: ["android"] },
          { id: "TC-0102", title: "플로우가 아직 없다", tags: ["smoke"], status: "active", flows: [] },
          { id: "TC-0103", title: "실패하는 플로우", tags: ["smoke"], status: "active", flows: ["android"] },
        ],
      },
    ]);
    expect(options.devices).toContainEqual({ id: FAKE_AVD, name: FAKE_AVD, platform: "android", kind: "emulator" });

    // 시작 거절은 코드로 온다
    const unknown = (await client.callTool({ name: "start_runs", arguments: { app: "nope", tag: "smoke" } })) as ToolText;
    expect(unknown.isError).toBe(true);
    expect(json(unknown)).toMatchObject({ error: { code: "unknown_app", candidates: ["demo"] } });
    expect(json(await client.callTool({ name: "start_runs", arguments: { app: "demo", tcIds: ["TC-0102"], deviceId: FAKE_AVD } }))).toMatchObject({ error: { code: "no_flow" } });

    // 태그로 시작: 플로우 없는 TC-0102 는 skipped 에 적힌다
    const started = json(await client.callTool({ name: "start_runs", arguments: { app: "demo", tag: "smoke", deviceId: FAKE_AVD } })) as { batch: RunBatch };
    const batch = started.batch;
    expect(batch).toMatchObject({ origin: "avocado-e2e-cli 1.0", target: "android", deviceId: FAKE_AVD, skipped: [{ tcId: "TC-0102", reason: "no_flow" }] });
    expect(batch.items.map((i) => i.tcId)).toEqual(["TC-0101", "TC-0103"]);

    // 열려 있던 실행 화면에 터미널에서 시작한 차례 실행이 보인다
    await expect(page.getByTestId("run-queue")).toContainText("터미널에서 시작(avocado-e2e-cli 1.0)", { timeout: 15_000 });
    // 도는 동안 실행 화면에서 새 묶음을 시작하면 거절된다(앱 전체에 하나)
    expect(json(await client.callTool({ name: "start_runs", arguments: { app: "demo", tcIds: ["TC-0101"], deviceId: FAKE_AVD } }))).toMatchObject({ error: { code: "queue_busy" } });
    // 다른 id 로는 읽거나 끄지 못한다
    expect(json(await client.callTool({ name: "cancel_runs", arguments: { batchId: "batch-other" } }))).toMatchObject({ error: { code: "unknown_batch" } });

    let done: RunBatch = batch;
    for (let i = 0; i < 20 && done.state !== "done"; i += 1) {
      done = json(await client.callTool({ name: "runs_status", arguments: { batchId: batch.id, waitSeconds: 10 } })) as RunBatch;
    }
    expect(done.state).toBe("done");
    expect(done.items.map((i) => [i.tcId, i.status])).toEqual([
      ["TC-0101", "passed"],
      ["TC-0103", "failed"],
    ]);

    // 실행 화면의 기록과 결과 화면에 두 실행이 생긴다
    const runIds = done.items.map((i) => i.runId ?? "");
    for (const id of runIds) await expect(page.getByTestId(`run-${id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "결과", exact: true }).click();
    for (const id of runIds) await expect(page.getByTestId(`results-run-${id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`results-run-${runIds[1] ?? ""}`).click();
    await expect(page.getByTestId("results-detail")).toContainText("실패");

    // 소켓으로 시작한 실행은 trigger mcp 로 기록한다(자동 화면 판정 제외, ADR 0035 결정 7)
    const db = new DatabaseSync(join(userDataDir, "db.sqlite"), { readOnly: true });
    const triggers = runIds.map((id) => (db.prepare("SELECT trigger FROM run WHERE id = ?").get(id) as { trigger: string }).trigger);
    db.close();
    expect(triggers).toEqual(["mcp", "mcp"]);

    // 새 묶음은 새 id. 그 id 로 취소하면 그 묶음만 멈춘다
    const second = (json(await client.callTool({ name: "start_runs", arguments: { app: "demo", tcIds: ["TC-0101"], deviceId: FAKE_AVD } })) as { batch: RunBatch }).batch;
    expect(second.id).not.toBe(batch.id);
    const canceled = json(await client.callTool({ name: "cancel_runs", arguments: { batchId: second.id } })) as RunBatch;
    expect(canceled.id).toBe(second.id);
    let after = canceled;
    for (let i = 0; i < 10 && after.state !== "done"; i += 1) {
      after = json(await client.callTool({ name: "runs_status", arguments: { batchId: second.id, waitSeconds: 10 } })) as RunBatch;
    }
    expect(after.items[0]?.status).toBe("canceled");
    // 끝난 첫 묶음은 그대로 읽힌다
    expect((json(await client.callTool({ name: "runs_status", arguments: { batchId: batch.id } })) as RunBatch).items[1]?.status).toBe("failed");
    expect(sdk.calls().some((c) => c.includes("am force-stop"))).toBe(true);
  } finally {
    await client.close();
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
