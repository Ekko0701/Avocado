import { expect, test } from "@playwright/test";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { doctor, startRun } from "./harness";

const TOKEN = "github_pat_VERIFYRUN_0123456789abcdefghijkl";

// 실행 준비 카드: 실행할 것을 탭(테스트 케이스 / 태그 / 플로우 파일)으로 고르고 기기·빌드는 한 번만 고른다.
// 워크스페이스를 연결하기 전에는 플로우 파일로만 실행할 수 있다. 실제 재생은 이 여정 밖이다(실기기)
test("실행 준비: 연결 전에는 플로우 파일만, 연결하면 테스트 케이스·태그·플로우 파일", async () => {
  const remote = await startFakeWorkspaceRemote(TOKEN);
  const run = await startRun("run-setup", { env: remote.env });
  try {
    await doctor(run);
    const { page } = run;
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "실행", exact: true }).click();
    const setup = page.getByTestId("run-setup");
    await expect(setup.getByRole("tab", { name: "플로우 파일" })).toHaveAttribute("aria-selected", "true");
    await expect(setup.getByRole("tab", { name: "테스트 케이스" })).toBeDisabled();
    await expect(setup.getByTestId("run-what-hint")).toContainText("워크스페이스를 연결하면");
    await run.shot("not-connected");

    await page.evaluate((token) => window.qa.secrets.set({ name: "githubToken", value: token }), TOKEN);
    await page.evaluate(() => window.qa.settings.update({ github: { owner: "acme" } }));
    await nav.getByRole("button", { name: "워크스페이스", exact: true }).click();
    await page.getByRole("button", { name: "연결(clone)" }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("main");
    await nav.getByRole("button", { name: "실행", exact: true }).click();

    await expect(setup.getByRole("tab", { name: "테스트 케이스" })).toHaveAttribute("aria-selected", "true");
    await setup.getByLabel("실행할 앱").selectOption("demo");
    await setup.getByLabel("실행할 테스트 케이스").selectOption("TC-0101");
    await expect(setup.getByRole("button", { name: "테스트 케이스 실행" })).toBeVisible();
    await run.shot("by-testcase");

    await setup.getByRole("tab", { name: "태그" }).click();
    await setup.getByLabel("실행할 태그").selectOption("smoke");
    await expect(setup.getByTestId("run-what-hint")).toContainText("TC-0101");
    await expect(setup.getByRole("button", { name: /태그로 차례 실행 \(1개\)/ })).toBeVisible();
    // 탭 바탕색 전환(120ms)이 끝난 뒤 찍는다
    await page.waitForTimeout(300);
    await run.shot("by-tag");

    await setup.getByRole("tab", { name: "플로우 파일" }).click();
    await expect(setup.getByRole("button", { name: "플로우 파일 고르기" })).toBeVisible();
    await expect(setup.getByTestId("run-what-hint")).toContainText("한 번 재생합니다");
    // 탭 바탕색 전환(120ms)이 끝난 뒤 찍는다
    await page.waitForTimeout(300);
    await run.shot("by-file");

    // 탭을 오가도 고른 것이 남는다
    await setup.getByRole("tab", { name: "테스트 케이스" }).click();
    await expect(setup.getByLabel("실행할 테스트 케이스")).toHaveValue("TC-0101");
    run.note("devices", await page.evaluate(() => window.qa.devices.list().then((d) => d.devices.filter((x) => x.state === "booted").length)));
  } finally {
    await run.close();
    await remote.close();
  }
});
