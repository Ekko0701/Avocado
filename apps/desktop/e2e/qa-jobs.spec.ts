import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

const AT = "2026-11-10T06:00:00.000Z";

// Claude Code 가 MCP 로 알려 온 기록(qa-jobs/jobs.json)을 화면이 그대로 보여 주는지 본다. 기기와 Maestro 는 쓰지 않는다
test("QA 작업 화면이 티켓별 진행 단계·마지막 보고·기기 실행·전체 기록을 보여 준다", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "qa-e2e-userdata-"));
  mkdirSync(join(userDataDir, "qa-jobs"), { recursive: true });
  writeFileSync(
    join(userDataDir, "qa-jobs", "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          id: "job-1",
          ticket: "QA/567",
          title: "설정 화면 버튼 이동",
          url: "https://example.invalid/task/567",
          stage: "mr",
          status: "succeeded",
          branch: "1.2.0/qa/fix/567",
          mrUrl: "https://example.invalid/mr/12",
          verification: "verified_after_retry",
          verificationNote: null,
          artifacts: [
            { kind: "spec", content: "설정 화면의 버튼을 누르면 안내 페이지가 열린다", at: AT },
            { kind: "analysis", content: "버튼 클릭 처리에서 주소가 빠져 있었다", at: AT },
          ],
          events: [
            { at: AT, stage: "received", message: "작업을 시작했다" },
            { at: AT, stage: "analysis", message: "버튼 클릭 처리에서 주소가 빠져 있었다" },
            { at: AT, stage: "mr", message: "MR 을 올렸다" },
          ],
          runs: [
            { runId: "run-before", label: "before", deviceName: "SM-P610", status: "failed", at: AT },
            { runId: "run-after", label: "after", deviceName: "SM-P610", status: "passed", at: AT },
          ],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    }),
  );
  const { app, page } = await launchApp({ userDataDir });
  await page.getByRole("button", { name: "QA 작업", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QA 작업" })).toBeVisible();

  const job = page.getByTestId("qajob-job-1");
  await expect(job).toContainText("QA/567 · 설정 화면 버튼 이동");
  await expect(job).toContainText("완료");
  await expect(job).toContainText("1.2.0/qa/fix/567");
  // 접혀 있을 때는 마지막 보고만 보인다
  await expect(job).toContainText("MR 을 올렸다");
  await expect(job).not.toContainText("버튼 클릭 처리에서 주소가 빠져 있었다");
  await expect(job.getByRole("button", { name: "수정 전 · 실패 · SM-P610" })).toBeEnabled();
  await expect(job.getByRole("button", { name: "수정 후 · 통과 · SM-P610" })).toBeEnabled();
  await expect(job.locator('[aria-current="step"]')).toHaveText("MR");
  await expect(job.getByTestId("qajob-verification")).toHaveText("다시 돌려 확인됨");

  // 기록을 펴면 보고 전체와 티켓·MR 주소가 글자로 보인다(주소는 링크가 아니다)
  await job.getByRole("button", { name: "기록" }).click();
  const detail = job.getByTestId("qajob-detail");
  await expect(detail).toContainText("버튼 클릭 처리에서 주소가 빠져 있었다");
  await expect(detail).toContainText("https://example.invalid/task/567");
  await expect(detail).toContainText("https://example.invalid/mr/12");
  await expect(detail.locator("a")).toHaveCount(0);
  // 단계별로 남긴 근거 글. 남기지 않은 것은 그렇다고 보인다
  await expect(detail.getByTestId("qajob-artifact-spec")).toContainText("설정 화면의 버튼을 누르면 안내 페이지가 열린다");
  await expect(detail.getByTestId("qajob-artifact-verdict")).toContainText("남기지 않음");

  // 기기 실행 버튼은 결과 화면으로 넘어간다
  await job.getByRole("button", { name: "수정 후 · 통과 · SM-P610" }).click();
  await expect(page.getByRole("heading", { name: "결과" })).toBeVisible();
  await app.close();
});

test("자동 처리 설정을 화면에서 바꿔 저장하고, 없는 저장소 폴더는 거절한다", async () => {
  const { app, page, userDataDir } = await launchApp();
  await page.getByRole("button", { name: "QA 작업", exact: true }).click();
  const panel = page.getByRole("region", { name: "자동 처리 설정" });
  // 처음에는 꺼져 있고 감시 항목이 없다
  await expect(panel.getByLabel("자동 처리 켜기")).not.toBeChecked();
  await expect(panel).toContainText("감시 항목이 없습니다");
  await expect(panel).toContainText("아직 확인한 적 없음");

  // 저장소 폴더는 main 의 선택 창으로만 고른다. 여기서는 IPC 로 한 항목을 넣고 화면이 그대로 보여 주는지 본다
  const saved = await page.evaluate(
    (repoPath) =>
      window.qa.qawatch.save({
        enabled: false,
        intervalMinutes: 30,
        days: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
        autoMr: false,
        autoComment: false,
        apps: [{ id: "a1", project: "앱-QA", tag: "자동수정", scope: "assigned_to_me", repoPath, enabled: true }],
      }),
    userDataDir,
  );
  expect(saved.settings.apps).toHaveLength(1);
  const missing = await page.evaluate(() =>
    window.qa.qawatch
      .save({ enabled: true, intervalMinutes: 30, days: [1], startHour: 9, endHour: 18, autoMr: false, autoComment: false, apps: [{ id: "a1", project: "앱-QA", tag: "자동수정", scope: "all", repoPath: "/없는/폴더", enabled: true }] })
      .then(() => "saved", (e: unknown) => String(e)),
  );
  expect(missing).toContain("저장소 폴더가 없다");

  await page.getByRole("button", { name: "홈", exact: true }).click();
  await page.getByRole("button", { name: "QA 작업", exact: true }).click();
  const item = panel.getByTestId("qawatch-app-a1");
  await expect(item.getByLabel("프로젝트")).toHaveValue("앱-QA");
  await expect(item.getByLabel("태그")).toHaveValue("자동수정");
  await expect(item.getByLabel("대상")).toHaveValue("assigned_to_me");
  await expect(item).toContainText(userDataDir);

  // 화면에서 켜고, 간격과 MR 허용을 바꿔 저장한다
  await panel.getByLabel("자동 처리 켜기").check();
  await panel.getByLabel("확인 간격(분)").fill("10");
  await panel.getByLabel("사람 확인 없이 MR 올리기").check();
  await panel.getByRole("button", { name: "저장", exact: true }).click();
  await expect(panel.getByTestId("qawatch-message")).toHaveText("저장했습니다");
  const state = await page.evaluate(() => window.qa.qawatch.get());
  expect(state.settings).toMatchObject({ enabled: true, intervalMinutes: 10, autoMr: true, autoComment: false });
  await app.close();
});
