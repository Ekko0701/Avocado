import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchApp } from "./launch";

type ToolText = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as ToolText).content.map((c) => c.text ?? "").join("\n");

// 실제 Claude 앱 대신, Claude 앱이 하는 그대로 등록한 명령(/usr/bin/nc -U <소켓>)을 띄워 붙는다(LLM 없음, ADR 0022)
test("Claude 연결: 앱이 MCP 소켓을 열고, nc 로 붙은 Claude 가 도구를 보며, 설정 화면에 연결이 보인다 (D17)", async () => {
  const { app, page, userDataDir } = await launchApp();
  const socketPath = join(userDataDir, "mcp", "avocado.sock");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const section = page.getByTestId("claude-connection");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("claude-listening")).toContainText("Claude 연결을 기다리는 중");
  await expect(section.getByTestId("claude-code-command")).toContainText(`"-U","${socketPath}"`);
  await expect(section.getByRole("radio", { name: /내 Claude 앱/ })).toBeChecked();

  const client = new Client({ name: "avocado-e2e", version: "1.0" });
  await client.connect(new StdioClientTransport({ command: "/usr/bin/nc", args: ["-U", socketPath], stderr: "pipe" }));
  try {
    expect(client.getInstructions()).toContain("attach_author");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(["attach_author", "author_status", "maestro_inspect_screen", "maestro_run", "submit_flow", "attach_judge", "get_judge_capture", "submit_judgement"]),
    );
    expect(textOf(await client.callTool({ name: "attach_judge", arguments: {} }))).toContain("진행 중인 화면 판정 작업이 없다");
    expect(tools).not.toContain("maestro_list_devices");
    expect(textOf(await client.callTool({ name: "author_status", arguments: {} }))).toContain("진행 중인 작업이 없다");
    const attach = (await client.callTool({ name: "attach_author", arguments: {} })) as ToolText;
    expect(attach.isError).toBe(true);
    expect(textOf(attach)).toContain("먼저 시작한다");

    // 설정 화면을 다시 열면 연결된 Claude 가 보인다
    await page.getByRole("button", { name: "플로우 만들기", exact: true }).click();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByTestId("claude-listening")).toContainText("avocado-e2e 1.0");
  } finally {
    await client.close();
  }

  // API 키 방식으로 바꾸면 저장되고 Claude 연결 안내는 숨긴다
  await page.getByTestId("claude-connection").getByRole("radio", { name: /Anthropic API 키/ }).check();
  await expect(page.getByTestId("claude-listening")).toHaveCount(0);
  expect(await page.evaluate(() => window.qa.settings.get().then((s) => s.settings.agent.provider))).toBe("api");
  await app.close();
});
