import { expect, test, type ElectronApplication } from "@playwright/test";
import { doctor, startRun } from "./harness";

// 설정 마법사: 단계 표시줄과 단계 하나(본문 스크롤, 아래 줄에 나중에 하기·이전·다음). 단계를 차례로 넘기며 찍는다.
// 환경 점검은 이 Mac 의 실제 도구를 읽기만 한다. 설치·등록·기기 준비·마법사 완료는 누르지 않는다
test("wizard: 단계 표시줄과 단계별 화면", async () => {
  const run = await startRun("wizard", { setupCompleted: false });
  const { page, app } = run;
  try {
    run.note("doctor", await doctor(run));
    await resize(app, 1440, 900);
    const steps = page.getByRole("list", { name: "마법사 단계" });
    await expect(page.getByRole("region", { name: "Claude 연결 단계" })).toBeVisible();
    await page.waitForTimeout(500);
    await run.shot("1-claude");
    await page.getByRole("region", { name: "Claude 연결 단계" }).getByRole("button", { name: "다음" }).click();
    await run.shot("2-token");
    await page.getByRole("region", { name: "GitHub 토큰 단계" }).getByRole("button", { name: "건너뛰기" }).click();
    const env = page.getByRole("region", { name: "환경 점검 단계" });
    await expect(env.getByTestId("check-xcode").getByTestId("check-status")).not.toHaveText("", { timeout: 60_000 });
    await page.waitForTimeout(500);
    await run.shot("3-environment");
    await env.getByRole("button", { name: "다음" }).click();
    await run.shot("4-workspace");
    await page.getByRole("region", { name: "워크스페이스 단계" }).getByRole("button", { name: "건너뛰기" }).click();
    await run.shot("5-device");
    await page.getByRole("region", { name: "QA 기기 단계" }).getByRole("button", { name: "건너뛰기" }).click();
    await expect(page.getByRole("region", { name: "완료 단계" }).getByText("확인 중")).toHaveCount(0, { timeout: 60_000 });
    await run.shot("6-finish");
    // 지나온 단계로 돌아가기
    await steps.getByRole("button", { name: /3단계/ }).click();
    await expect(env).toBeVisible();
    await resize(app, 900, 760);
    await page.waitForTimeout(500);
    await run.shot("narrow");
  } finally {
    await run.close();
  }
});

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
  await new Promise((r) => setTimeout(r, 300));
}
