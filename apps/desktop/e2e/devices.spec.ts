import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

// 이 Mac 의 실제 simctl 을 읽기만 한다(기기를 만들거나 켜거나 지우지 않는다)
test("기기 화면이 iOS 버전·기종을 고르는 칸, QA 기기 목록과 준비 버튼을 보여 준다", async () => {
  const { app, page } = await launchApp();
  await page.getByRole("button", { name: "기기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "기기", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "iOS 시뮬레이터 준비" })).toBeEnabled();
  const list = await page.evaluate(() => window.qa.devices.list());
  expect(Array.isArray(list.devices)).toBe(true);
  // 시뮬레이터는 앱이 만든 것만 보인다(연결된 iPhone 은 실기기로 따로 나온다)
  for (const d of list.devices.filter((x) => x.platform === "ios" && x.kind === "simulator")) expect(d.name.startsWith("Avocado ") || d.name.startsWith("QA Tool ")).toBe(true);
  // Android 폰 연결 안내(ADR 0030). 연결된 폰이 있으면 종료 버튼이 없다(사람의 폰은 끄지 않는다)
  const prepare = page.getByRole("region", { name: "QA 기기 준비" });
  await prepare.getByRole("tab", { name: "Android 폰" }).click();
  await expect(page.getByTestId("phone-hint")).toBeVisible();
  await expect(prepare.getByRole("button", { name: "연결한 폰 찾기" })).toBeVisible();
  // Android 에뮬레이터 탭에는 AVD 고르기와 준비 버튼이 있다(SDK 가 없으면 꺼져 있다)
  await prepare.getByRole("tab", { name: "Android 에뮬레이터" }).click();
  await expect(prepare.getByLabel("AVD")).toBeVisible();
  await expect(prepare.getByRole("button", { name: "Android 에뮬레이터 준비" })).toBeVisible();
  await prepare.getByRole("tab", { name: "iOS 시뮬레이터" }).click();
  // 페이지는 창 높이에 맞고 두 칸의 머리말·본문·붙박이 줄이 폭을 다 쓴다
  expect(await page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.scrollHeight - main.clientHeight : -1;
  })).toBeLessThanOrEqual(1);
  const widths = await prepare.evaluate((pane) => [pane.clientWidth, ...[...pane.children].map((c) => (c as HTMLElement).offsetWidth)]);
  expect(widths.slice(1).every((w) => w === widths[0])).toBe(true);
  for (const d of list.devices.filter((x) => x.kind === "real")) {
    await expect(page.getByTestId(`device-${d.platform}-${d.id}`).getByRole("button", { name: "종료" })).toHaveCount(0);
  }

  // 고를 수 있는 iOS 버전(최신 먼저)과 그 버전의 iPhone·iPad. 화면의 기본값은 기본 기종을 지원하는 가장 새 iOS
  const options = await page.evaluate(() => window.qa.devices.iosOptions());
  expect(options.defaultDeviceType).toBe("iPhone 17");
  if (options.runtimes.length > 0) {
    const versions = page.getByLabel("iOS 버전");
    await expect(versions.locator("option")).toHaveCount(options.runtimes.length);
    const preferred = options.runtimes.find((r) => r.deviceTypes.some((t) => t.name === "iPhone 17")) ?? options.runtimes[0];
    await expect(versions).toHaveValue(preferred?.id ?? "");
    if (preferred?.deviceTypes.some((t) => t.name === "iPhone 17")) await expect(page.getByLabel("기종")).toHaveValue("iPhone 17");
  }

  // 지우기는 IPC 에서 UDID 형식부터 검사한다(형식이 아니면 main 까지 가지 않는다)
  const bad = await page.evaluate(() => window.qa.devices.deleteIos({ id: "../../x" }).then(() => "ok", (e: unknown) => String(e)));
  expect(bad).toContain("invalid-input");
  await app.close();
});

// iPhone 실기기(ADR 0034): 목록·점검·러너 준비와 설정의 서명 팀. main 의 기기 핸들러를 바꿔 끼운다(화면 흐름 확인, 실제 iPhone 은 ios-device.real.test.ts)
test("iPhone 탭: 점검 목록과 할 일, 러너 준비, 설정의 서명 팀", async () => {
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const phone = { id: "00008160-001C79811EA80036", platform: "ios", kind: "real", name: "테스트 iPhone", osVersion: "27.0.1", state: "unknown", managed: false, serial: null, locale: null };
      const base = [
        { id: "connected", label: "연결", ok: true, detail: "테스트 iPhone (iOS 27.0.1)" },
        { id: "developerMode", label: "iPhone 개발자 모드", ok: true, detail: "켜짐" },
        { id: "devToolsSecurity", label: "Mac 개발 도구 보안", ok: false, detail: "터미널에서 sudo DevToolsSecurity -enable 을 실행한다(관리자 암호가 필요하다)" },
        { id: "unlocked", label: "잠금 해제", ok: true, detail: "잠금 해제됨" },
        { id: "signingTeam", label: "러너 서명 팀", ok: true, detail: "Demo Person (TEAMAAAA11)" },
        { id: "tool", label: "agent-device", ok: false, detail: "준비하면 고정 버전을 내려받아 설치한다(약 2MB)" },
      ];
      const g = globalThis as unknown as { iphoneCalls: boolean[]; devToolsOn: boolean };
      g.iphoneCalls = [];
      g.devToolsOn = false;
      ipcMain.removeHandler("devices:list");
      ipcMain.handle("devices:list", () => ({ devices: [{ ...phone, state: g.devToolsOn ? "booted" : "unknown" }], androidAvailable: false }));
      ipcMain.removeHandler("devices:checkIosDevice");
      ipcMain.handle("devices:checkIosDevice", (_e, input: { id: string; buildRunner: boolean }) => {
        g.iphoneCalls.push(input.buildRunner);
        const checks = base.map((c) => (c.id === "devToolsSecurity" && g.devToolsOn ? { ...c, ok: true, detail: "켜짐" } : c));
        if (input.buildRunner) {
          const done = checks.map((c) => (c.id === "tool" ? { ...c, ok: true, detail: "설치함" } : c));
          return { deviceId: input.id, checks: [...done, { id: "runner", label: "러너", ok: true, detail: "서명·설치하고 응답을 확인했다" }], ready: true };
        }
        return { deviceId: input.id, checks, ready: false };
      });
      ipcMain.removeHandler("devices:iosSigningTeams");
      ipcMain.handle("devices:iosSigningTeams", () => [
        { id: "TEAMAAAA11", name: "Demo Person" },
        { id: "TEAMBBBB22", name: "Sample Inc" },
      ]);
    });

    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "기기", exact: true }).click();
    const row = page.getByTestId("device-ios-00008160-001C79811EA80036");
    await expect(row).toContainText("준비 필요");
    await expect(row).toContainText("iOS 27.0.1 실기기");
    await expect(row.getByRole("button")).toHaveCount(0);

    // 탭을 열면 바로 점검한다(러너는 빌드하지 않는다). 할 일이 있으면 준비 버튼이 잠긴다
    const prepare = page.getByRole("region", { name: "QA 기기 준비" });
    await prepare.getByRole("tab", { name: "iPhone 실기기" }).click();
    await expect(page.getByTestId("iphone-checks")).toBeVisible();
    await expect(page.getByTestId("iphone-check-devToolsSecurity")).toContainText("할 일");
    await expect(page.getByTestId("iphone-check-devToolsSecurity").locator("code")).toHaveText("sudo DevToolsSecurity -enable");
    await expect(page.getByTestId("device-message")).toHaveText("할 일 2개를 마치고 다시 확인합니다");
    // 탭 4개가 있어도 준비 칸이 가로로 넘치지 않는다
    expect(await prepare.evaluate((pane) => [...pane.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible").length)).toBe(0);
    await expect(prepare.getByRole("button", { name: "iPhone 준비" })).toBeDisabled();

    // 사람이 Mac 설정을 켠 뒤 다시 확인 → 도구만 남으면 준비할 수 있다 → 러너 준비
    await app.evaluate(() => {
      (globalThis as unknown as { devToolsOn: boolean }).devToolsOn = true;
    });
    await prepare.getByRole("button", { name: "다시 확인" }).click();
    await expect(page.getByTestId("iphone-check-devToolsSecurity")).toContainText("확인");
    await expect(prepare.getByRole("button", { name: "iPhone 준비" })).toBeEnabled();
    await prepare.getByRole("button", { name: "iPhone 준비" }).click();
    await expect(page.getByTestId("iphone-check-runner")).toContainText("확인");
    await expect(page.getByTestId("device-message")).toHaveText("테스트 iPhone: 준비됨 · 실행 화면에서 고를 수 있습니다");
    await expect(prepare.getByRole("button", { name: "러너 다시 준비" })).toBeEnabled();
    await expect(row).toContainText("연결됨");
    expect(await app.evaluate(() => (globalThis as unknown as { iphoneCalls: boolean[] }).iphoneCalls)).toEqual([false, false, true]);

    // 설정 › 기기: 키체인에서 찾은 팀을 골라 저장한다
    await nav.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("navigation", { name: "설정 구역" }).getByRole("button", { name: /기기/ }).click();
    const team = page.getByTestId("ios-signing-team");
    await expect(team.locator("option")).toHaveText(["고르지 않음", "Demo Person (TEAMAAAA11)", "Sample Inc (TEAMBBBB22)"]);
    await team.selectOption("TEAMAAAA11");
    await expect(page.getByText("dev.avocado.agentdevice.teamaaaa11.runner", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
    const saved = await page.evaluate(() => window.qa.settings.get());
    expect(saved.settings.devices).toEqual({ locale: "ko_KR", iosSigningTeam: "TEAMAAAA11" });
    await expect(page.getByRole("navigation", { name: "설정 구역" })).toContainText("iPhone 서명 TEAMAAAA11");
  } finally {
    await app.close();
  }
});

// 새로고침 없이: 케이블을 꽂고 빼면 기기 목록과 iPhone 점검이 저절로 바뀐다(main 의 기기 핸들러를 바꿔 끼운다)
test("기기를 꽂고 빼면 새로고침 없이 목록과 iPhone 점검이 바뀐다", async () => {
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { plugged: boolean; checks: number };
      g.plugged = false;
      g.checks = 0;
      const phone = { id: "00008160-001C79811EA80036", platform: "ios", kind: "real", name: "테스트 iPhone", osVersion: "27.0.1", managed: false, serial: null, locale: null };
      ipcMain.removeHandler("devices:list");
      ipcMain.handle("devices:list", () => ({ devices: [{ ...phone, state: g.plugged ? "booted" : "unknown" }], androidAvailable: false }));
      ipcMain.removeHandler("devices:checkIosDevice");
      ipcMain.handle("devices:checkIosDevice", (_e, input: { id: string }) => {
        g.checks += 1;
        return {
          deviceId: input.id,
          checks: [
            { id: "connected", label: "연결", ok: g.plugged, detail: g.plugged ? "테스트 iPhone (iOS 27.0.1)" : "연결이 끊겨 있다. 케이블로 연결하고 잠금을 푼다" },
            { id: "tool", label: "agent-device", ok: true, detail: "설치됨" },
          ],
          ready: g.plugged,
        };
      });
    });
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기기", exact: true }).click();
    const row = page.getByTestId("device-ios-00008160-001C79811EA80036");
    await expect(row).toContainText("준비 필요");
    await page.getByRole("region", { name: "QA 기기 준비" }).getByRole("tab", { name: "iPhone 실기기" }).click();
    await expect(page.getByTestId("iphone-check-connected")).toContainText("할 일");

    // 꽂는다 → 버튼을 누르지 않아도 목록과 점검이 바뀐다
    await app.evaluate(() => {
      (globalThis as unknown as { plugged: boolean }).plugged = true;
    });
    await expect(row).toContainText("연결됨", { timeout: 10_000 });
    await expect(page.getByTestId("iphone-check-connected")).toContainText("확인", { timeout: 10_000 });

    // 뺀다 → 다시 저절로
    await app.evaluate(() => {
      (globalThis as unknown as { plugged: boolean }).plugged = false;
    });
    await expect(row).toContainText("준비 필요", { timeout: 10_000 });
    await expect(page.getByTestId("iphone-check-connected")).toContainText("할 일", { timeout: 10_000 });
    // 상태가 바뀔 때만 다시 점검한다(처음 1번 + 꽂음 1번 + 뺌 1번)
    await page.waitForTimeout(4000);
    expect(await app.evaluate(() => (globalThis as unknown as { checks: number }).checks)).toBe(3);
  } finally {
    await app.close();
  }
});
