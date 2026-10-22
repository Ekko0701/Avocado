import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2EWS_0123456789abcdefghijklmnopqrstu";

function allFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    const st = statSync(p, { throwIfNoEntry: false });
    return !st ? [] : st.isDirectory() ? allFiles(p) : [p];
  });
}

test("워크스페이스: 앱에서 TC 를 고쳐 저장하면 작업 브랜치에 커밋되고, 검토 요청으로 PR 이 생긴다 (T-110)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page, userDataDir } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));

    await page.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("acme/qa-workspace");
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await expect(page.getByTestId("workspace-status")).toContainText("바뀐 파일");

    // TC 화면에서 원문으로 고친다
    await page.getByRole("button", { name: "TC", exact: true }).click();
    await expect(page.getByTestId("tc-demo-TC-0101")).toContainText("이메일로 회원가입하면 홈 화면이 열린다");
    await expect(page.getByTestId("tc-demo-TC-0101")).toContainText("ios");
    await page.getByTestId("tc-demo-TC-0101").getByRole("button", { name: "demo/TC-0101" }).click();
    await page.getByRole("tab", { name: "원문" }).click();
    const editor = page.getByLabel("TC 원문");
    const original = await editor.inputValue();
    await editor.fill(original.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고"));
    await page.getByLabel("변경 요약").fill("connect screen wording");
    await page.getByRole("button", { name: "저장(커밋)" }).click();
    await expect(page.getByTestId("tc-message")).toContainText("qa/qa-bot/TC-0101-connect-screen-wording 에 커밋했습니다");

    // 형식이 틀리면 린트가 막아 저장 버튼이 꺼진다
    await editor.fill("## 스텝\n1. 아무것도");
    await expect(page.getByTestId("tc-lint")).toContainText("차단");
    await expect(page.getByRole("button", { name: "저장(커밋)" })).toBeDisabled();
    await editor.fill(original.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고"));

    await expect(page.getByLabel("PR 제목")).toHaveValue("TC-0101 connect screen wording");
    await page.getByRole("button", { name: "검토 요청(PR)" }).click();
    await expect(page.getByTestId("tc-pr")).toContainText("PR #7");
    expect(remote.api.pulls).toEqual([
      expect.objectContaining({ repo: "acme/qa-workspace", head: "qa/qa-bot/TC-0101-connect-screen-wording", base: "main", title: "TC-0101 connect screen wording" }),
    ]);
    expect(remote.git(remote.bare, "log", "-1", "--format=%s", "qa/qa-bot/TC-0101-connect-screen-wording")).toBe("tc: TC-0101 connect screen wording");
    expect(remote.git(remote.bare, "log", "-1", "--format=%s", "main")).toBe("template");
    await app.close();

    const leaked = allFiles(userDataDir).filter((f) => readFileSync(f).includes(Buffer.from(TOKEN)));
    expect(leaked).toEqual([]);
    expect(readFileSync(join(userDataDir, "workspaces", "qa-workspace", ".git", "config"), "utf8")).not.toContain(TOKEN);
  } finally {
    await remote.close();
  }
});

test("워크스페이스에서 실행: TC·태그를 고르면 main 이 플로우를 찾아 차례 실행에 넣는다 (PLAN 12장)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(() => window.qa.workspace.connect());

    await page.getByRole("button", { name: "실행", exact: true }).click();
    const panel = page.getByTestId("workspace-run");
    await expect(panel).toBeVisible();
    await panel.getByLabel("실행할 앱").selectOption("demo");
    await panel.getByLabel("실행할 TC").selectOption("TC-0101");
    // 실행 중인 기기가 없으면 시작할 수 없다
    await expect(panel.getByRole("button", { name: "TC 실행" })).toBeDisabled();
    await panel.getByLabel("실행할 태그").selectOption("smoke");
    await expect(panel.getByRole("button", { name: /태그로 차례 실행 \(1개\)/ })).toBeDisabled();

    // 화면을 우회한 요청: 없는 플로우는 main 이 거부하고, 기기가 없으면 차례 실행에 오류로 남는다
    expect(
      await page.evaluate(() => window.qa.runs.startFromWorkspace({ app: "demo", target: "android", tcId: "TC-0101", deviceId: "x", buildId: null }).then(() => "ok", (e: unknown) => String(e))),
    ).toContain("플로우가 없다");
    expect(
      await page.evaluate(() => window.qa.runs.startFromWorkspace({ app: "demo", target: "ios", tcId: "TC-0101", tag: "smoke", deviceId: "x", buildId: null } as never).then(() => "ok", (e: unknown) => String(e))),
    ).toContain("invalid-input");
    await page.evaluate(() => window.qa.runs.startFromWorkspace({ app: "demo", target: "ios", tag: "smoke", deviceId: "no-device", buildId: null }));
    await expect.poll(async () => (await page.evaluate(() => window.qa.runs.queue())).errors.join(" ")).toContain("TC-0101");
    await app.close();
  } finally {
    await remote.close();
  }
});

test("홈: 워크스페이스 상태, 최근 실행, 내 PR 이 보인다 (PLAN 12장)", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page } = await launchApp({ env: remote.env });
    await expect(page.getByTestId("home-workspace")).toContainText("GitHub 조직");
    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await page.evaluate(async () => {
      await window.qa.workspace.connect();
      const tc = await window.qa.workspace.readTestcase({ app: "demo", id: "TC-0101" });
      await window.qa.workspace.saveTestcase({ app: "demo", id: "TC-0101", text: tc.text.replace("홈 화면이 열리고", "홈 화면(홈)이 열리고"), summary: "home check" });
      await window.qa.workspace.requestReview({ title: "TC-0101 문구", body: "홈 화면 확인" });
    });
    await page.getByRole("button", { name: "TC", exact: true }).click();
    await page.getByRole("button", { name: "홈", exact: true }).click();
    await expect(page.getByTestId("home-workspace")).toContainText("acme/qa-workspace");
    await expect(page.getByTestId("home-workspace")).toContainText("qa/qa-bot/TC-0101-home-check");
    await expect(page.getByTestId("home-pulls")).toContainText("#7 TC-0101 문구");
    await expect(page.getByTestId("home-runs")).toContainText("실행 기록이 없습니다.");
    await app.close();
  } finally {
    await remote.close();
  }
});
