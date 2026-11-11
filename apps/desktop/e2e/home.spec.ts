import { expect, test } from "@playwright/test";
import { expectHomeRows, homeLayout } from "./home-layout";
import { seedRuns } from "../verify/seed-runs";
import { launchApp } from "./launch";

const at = (daysAgo: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

test("홈: 윗줄(최근 14일 실행 | 최근 실행)의 높이는 최근 실행이 0건·2건·5건일 때 모두 같고, 차트가 그 높이를 채운다", async () => {
  test.setTimeout(90_000);
  const { app, page, userDataDir } = await launchApp();
  try {
    // 지표 3칸은 없다. 기록이 없을 때는 안내만 보인다
    await expect(page.getByTestId("home-runs")).toContainText("실행 기록이 없습니다.");
    await expect(page.getByTestId("home-trend")).toContainText("실행 기록이 쌓이면");
    await expect(page.getByText("지금 실패 중")).toHaveCount(0);
    await expect(page.getByText("플로우 있는 테스트 케이스")).toHaveCount(0);
    const empty = await homeLayout(page);
    expectHomeRows(empty);
    expect(empty.recentRows).toBe(0);

    // 2건: 홈은 8초 안에 실행 기록을 다시 읽는다
    seedRuns(userDataDir, [
      { id: "run-1", fixture: "ios-pass", target: "ios", status: "passed", createdAt: at(1, 9) },
      { id: "run-2", fixture: "ios-fail", target: "ios", status: "failed", createdAt: at(0, 9), title: "이름이 아주 길어서 좁은 카드에서는 한 줄에 다 들어가지 않는 테스트 케이스의 플로우" },
    ]);
    await expect(page.getByTestId("home-recent-run-2")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("home-chart")).toBeVisible();
    const two = await homeLayout(page);
    expectHomeRows(two);
    expect(two.recentRows).toBe(2);
    expect(Math.abs(two.trend.height - empty.trend.height), "0건과 2건의 윗줄 높이").toBeLessThanOrEqual(1);

    // 6건: 최근 5건만 보인다
    seedRuns(userDataDir, [
      { id: "run-3", fixture: "ios-pass", target: "ios", status: "passed", createdAt: at(0, 10), tcId: "TC-0002", title: "로그인" },
      { id: "run-4", fixture: "android-pass", target: "android", status: "passed", createdAt: at(0, 11) },
      { id: "run-5", fixture: "ios-pass", target: "ios", status: "passed", createdAt: at(0, 12) },
      { id: "run-6", fixture: "ios-fail", target: "ios", status: "failed", createdAt: at(0, 13) },
    ]);
    await expect(page.getByTestId("home-recent-run-6")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("home-recent-run-1")).toHaveCount(0);
    const full = await homeLayout(page);
    expectHomeRows(full);
    expect(full.recentRows).toBe(5);
    expect(Math.abs(full.trend.height - two.trend.height), "2건과 5건의 윗줄 높이").toBeLessThanOrEqual(1);
    expect(Math.abs((full.chart?.height ?? 0) - (two.chart?.height ?? -9)), "2건과 5건의 차트 높이").toBeLessThanOrEqual(1);

    // 긴 이름은 한 줄로 줄이고 전체는 title 로 보인다. 누르면 그 실행의 결과가 열린다
    await expect(page.getByTestId("home-recent-run-2").getByRole("button")).toHaveAttribute("title", /한 줄에 다 들어가지 않는/);
    await page.getByTestId("home-recent-run-6").getByRole("button").click();
    await expect(page.getByRole("heading", { name: "결과", level: 1 })).toBeVisible();
  } finally {
    await app.close();
  }
});
