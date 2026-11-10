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

  // 기록을 펴면 보고 전체와 티켓·MR 주소가 글자로 보인다(주소는 링크가 아니다)
  await job.getByRole("button", { name: "기록" }).click();
  const detail = job.getByTestId("qajob-detail");
  await expect(detail).toContainText("버튼 클릭 처리에서 주소가 빠져 있었다");
  await expect(detail).toContainText("https://example.invalid/task/567");
  await expect(detail).toContainText("https://example.invalid/mr/12");
  await expect(detail.locator("a")).toHaveCount(0);

  // 기기 실행 버튼은 결과 화면으로 넘어간다
  await job.getByRole("button", { name: "수정 후 · 통과 · SM-P610" }).click();
  await expect(page.getByRole("heading", { name: "결과" })).toBeVisible();
  await app.close();
});
