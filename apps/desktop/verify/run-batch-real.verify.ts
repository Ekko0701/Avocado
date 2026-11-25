import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import type { RunBatch } from "@qa/shared";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { doctor, startRun } from "./harness";
import { FAKE_ID, TOOLS, bootedSims, seedSettingsWorkspace } from "./settings-workspace";

// T-120 실제 확인(ADR 0035): 실제 Maestro·시뮬레이터에서 설정 앱 플로우를 소켓 MCP 클라이언트(start_runs)로 시작해 통과와 실패를 한 번씩 본다.
// 워크스페이스는 새 앱 데이터의 로컬 워크스페이스에 설정 앱 TC 둘을 넣는다. 도구는 out/e2e/real-run-userdata/tools 를 복제한다.
// QA 시뮬레이터를 켠다. 이 실행이 켠 것만 마지막에 끈다
type ToolText = { content: { text?: string }[]; isError?: boolean };
const json = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]?.text ?? "null");

test("실행 묶음 실제 확인: 소켓 클라이언트로 시작한 설정 앱 플로우가 시뮬레이터에서 통과·실패한다", async () => {
  test.setTimeout(30 * 60_000);
  if (!existsSync(TOOLS)) throw new Error(`tools 폴더가 없다: ${TOOLS}`);
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-verify-run-batch-"));
  execFileSync("/bin/cp", ["-cR", TOOLS, join(userDataDir, "tools")]);
  seedSettingsWorkspace(userDataDir);
  const before = bootedSims();
  const run = await startRun("run-batch-real", { userDataDir, workspaceSource: "local" });
  const { page } = run;
  const nav = page.getByRole("navigation", { name: "주 메뉴" });
  const client = new Client({ name: "avocado-verify-cli", version: "1.0" });
  let simId: string | null = null;
  try {
    run.note("doctor", await doctor(run));
    expect((await page.evaluate(() => window.qa.setup.check())).tools.every((t) => t.installed)).toBe(true);
    await page.evaluate((v) => window.qa.secrets.set({ name: "account:settings:QA_FIXTURE_ACCOUNT_ID", value: v }), FAKE_ID);
    const sim = await page.evaluate(() => window.qa.devices.prepareIos({}));
    simId = sim.id;
    run.note("device", sim);

    await nav.getByRole("button", { name: "실행", exact: true }).click();
    await client.connect(new StdioClientTransport({ command: "/usr/bin/nc", args: ["-U", join(userDataDir, "mcp", "avocado.sock")], stderr: "pipe" }));
    run.note("run_options", json(await client.callTool({ name: "run_options", arguments: {} })));

    const results: RunBatch[] = [];
    for (const tcId of ["TC-0001", "TC-0002"]) {
      const started = json(await client.callTool({ name: "start_runs", arguments: { app: "settings", tcIds: [tcId], deviceId: sim.id } })) as { batch?: RunBatch; error?: unknown };
      run.note(`start ${tcId}`, started);
      if (!started.batch) throw new Error(`시작하지 못했다: ${JSON.stringify(started.error)}`);
      await expect(page.getByTestId("run-queue")).toContainText("터미널에서 시작(avocado-verify-cli 1.0)", { timeout: 15_000 });
      await run.shot(`running-${tcId}`);
      let batch = started.batch;
      for (let i = 0; i < 60 && batch.state !== "done"; i += 1) batch = json(await client.callTool({ name: "runs_status", arguments: { batchId: batch.id, waitSeconds: 30 } })) as RunBatch;
      run.note(`done ${tcId}`, batch);
      results.push(batch);
      await expect(page.getByTestId(`run-${batch.items[0]?.runId ?? ""}`)).toBeVisible({ timeout: 15_000 });
      await run.shot(`done-${tcId}`);
    }
    expect(results.map((b) => b.items[0]?.status)).toEqual(["passed", "failed"]);

    await nav.getByRole("button", { name: "결과", exact: true }).click();
    for (const b of results) await expect(page.getByTestId(`results-run-${b.items[0]?.runId ?? ""}`)).toBeVisible();
    await page.getByTestId(`results-run-${results[1]?.items[0]?.runId ?? ""}`).click();
    await expect(page.getByTestId("results-detail")).toContainText("실패");
    await run.shot("results-failed");

    const db = new DatabaseSync(join(userDataDir, "db.sqlite"), { readOnly: true });
    const rows = results.map((b) => db.prepare("SELECT trigger, status FROM run WHERE id = ?").get(b.items[0]?.runId ?? "") as { trigger: string; status: string });
    db.close();
    run.note("db", rows);
    expect(rows).toEqual([
      { trigger: "mcp", status: "passed" },
      { trigger: "mcp", status: "failed" },
    ]);
  } finally {
    await client.close();
    await run.close();
    if (simId && !before.includes(simId)) execFileSync("/usr/bin/xcrun", ["simctl", "shutdown", simId]);
  }
});
