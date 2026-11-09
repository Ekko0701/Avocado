import { expect, test } from "@playwright/test";
import { doctor, startRun } from "./harness";

// 앱이 격리된 데이터 폴더로 뜨고, 빌드가 소스보다 새롭고, 홈 화면이 그려지는지만 본다(읽기 전용)
test("doctor: 이 인스턴스를 몰아도 되는가", async () => {
  const run = await startRun("doctor");
  try {
    const report = await doctor(run);
    run.note("doctor", report);
    await expect(run.page.getByTestId("app-version")).toHaveText(report.version);
    await run.shot("home");
  } finally {
    await run.close();
  }
});
