import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { doctor, startRun } from "./harness";

// 화면 둘러보기(읽기 전용): 사이드바의 모든 화면을 라이트·다크로 찍는다. 스타일을 바꾼 뒤 한눈에 보려고 쓴다.
// page.screenshot 은 웹 내용만 찍어 macOS 재질(vibrancy)이 비치는 곳은 비어 보인다.
// QA_VERIFY_NATIVE=1 이면 screencapture 로 실제 창(신호등·재질 포함)도 찍는다(화면 기록 권한 필요).
const PAGES = ["홈", "테스트 케이스", "플로우 만들기", "실행", "결과", "테스트 계정", "기기", "빌드", "워크스페이스", "설정 마법사", "설정"];

test("screens: 모든 화면 라이트·다크", async () => {
  test.setTimeout(120_000);
  const run = await startRun("screens");
  try {
    run.note("doctor", await doctor(run));
    const nav = run.page.getByRole("navigation", { name: "주 메뉴" });
    for (const theme of ["light", "dark"] as const) {
      // 창 재질은 nativeTheme 을, 웹 내용은 Playwright 의 색 모드 흉내(기본 light)를 따른다. 둘 다 바꾼다
      await run.app.evaluate(({ nativeTheme }, source) => {
        nativeTheme.themeSource = source;
      }, theme);
      await run.page.emulateMedia({ colorScheme: theme });
      for (const name of PAGES) {
        await nav.getByRole("button", { name, exact: true }).click();
        await expect(run.page.locator("main h1").first()).toBeVisible();
        await run.page.waitForTimeout(400);
        await run.shot(`${theme}-${name.replaceAll(" ", "")}`);
        if (process.env["QA_VERIFY_NATIVE"] === "1") await nativeShot(run, `${theme}-${name.replaceAll(" ", "")}-native`);
      }
      // 마지막 화면(설정)을 내려 본문이 툴바 밑으로 지나가는 모습(스크롤 가장자리 효과)을 본다
      await run.page.locator("main").evaluate((main) => main.scrollBy(0, 360));
      await run.page.waitForTimeout(200);
      await run.shot(`${theme}-scrolled`);
      if (process.env["QA_VERIFY_NATIVE"] === "1") await nativeShot(run, `${theme}-scrolled-native`);
    }
  } finally {
    await run.close();
  }
});

/** 이 실행이 띄운 창만 screencapture -l 로 찍는다(창 ID 는 getMediaSourceId 의 "window:<id>:0") */
async function nativeShot(run: Awaited<ReturnType<typeof startRun>>, label: string) {
  const source = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? "");
  const id = /^window:(\d+):/.exec(source)?.[1];
  if (!id) throw new Error(`창 ID 를 못 찾았다: ${source}`);
  execFileSync("screencapture", ["-x", "-o", `-l${id}`, join(run.dir, `${label}.png`)]);
}
