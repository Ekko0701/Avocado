import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

const IOS = {
  path: "/Users/me/src/Demo",
  container: "/Users/me/src/Demo/Demo.xcworkspace",
  tools: ["cocoapods"],
  schemes: ["Demo", "Demo-Dev"],
  configurations: ["Debug", "Release"],
  git: { commit: "0123456789abcdef0123456789abcdef01234567", changes: 1 },
  scheme: null,
  configuration: null,
  teamScheme: "Demo-Dev",
  teamConfiguration: "Debug",
  problem: null,
};
const BUILD = {
  id: "b-project",
  app: "demo",
  target: "ios",
  appId: "com.example.demo",
  version: "1.4.0",
  buildNumber: "12",
  commit: "0123456789abcdef0123456789abcdef01234567",
  source: "project",
  path: "/tmp/Demo.app",
  createdAt: "2026-10-28T00:00:00.000Z",
  label: "Demo-Dev · Debug · 커밋 안 한 변경 1개",
};

// xcodebuild 는 실제로 돌리지 않는다. main 의 프로젝트 빌드 핸들러만 정해진 결과로 바꿔 화면 흐름을 본다(실제 빌드는 project-builds.real.test.ts)
test("프로젝트로 빌드(ADR 0025): 연결하면 팀 기본 스킴·구성이 골라지고, 빌드하면 프로젝트 빌드로 등록된다", async () => {
  const { app, page } = await launchApp();
  await app.evaluate(
    ({ ipcMain }, data) => {
      let linked = false;
      const calls: unknown[] = [];
      (globalThis as unknown as { projectCalls: unknown[] }).projectCalls = calls;
      const swap = (channel: string, handler: (event: unknown, input: unknown) => unknown) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      swap("builds:projectStatus", () => ({ app: "demo", ios: linked ? data.ios : null }));
      swap("builds:linkProject", () => {
        linked = true;
        return { app: "demo", ios: data.ios };
      });
      swap("builds:buildProject", (_event, input) => {
        calls.push(input);
        return data.build;
      });
      swap("builds:list", () => (calls.length > 0 ? [data.build] : []));
    },
    { ios: IOS, build: BUILD },
  );
  await page.getByRole("button", { name: "빌드", exact: true }).click();
  await page.getByLabel("앱 ID").fill("demo");
  const panel = page.getByTestId("project-build");
  await panel.getByRole("button", { name: "프로젝트 연결" }).click();
  await expect(panel.getByTestId("project-info")).toContainText("/Users/me/src/Demo");
  await expect(panel.getByTestId("project-info")).toContainText("Demo.xcworkspace · CocoaPods");
  await expect(panel.getByTestId("project-info")).toContainText("0123456789 · 커밋 안 한 변경 1개 포함");
  // 팀 기본값(app.yaml)이 먼저 골라진다
  await expect(panel.getByLabel("스킴")).toHaveValue("Demo-Dev");
  await expect(panel.getByLabel("구성")).toHaveValue("Debug");
  await panel.getByLabel("구성").selectOption("Release");

  await panel.getByRole("button", { name: "빌드 시작" }).click();
  await expect(panel.getByTestId("project-message")).toContainText("등록했습니다: com.example.demo 1.4.0 (12) · Demo-Dev · Debug · 커밋 안 한 변경 1개");
  await expect(page.getByTestId("build-b-project")).toContainText("프로젝트 · Demo-Dev · Debug · 커밋 안 한 변경 1개");
  const calls = await app.evaluate(() => (globalThis as unknown as { projectCalls: unknown[] }).projectCalls);
  expect(calls).toEqual([{ app: "demo", scheme: "Demo-Dev", configuration: "Release" }]);
  await app.close();
});

test("프로젝트 빌드 IPC 는 입력을 검사하고, 선택 창을 취소하면 아무것도 연결하지 않는다", async () => {
  const { app, page } = await launchApp();
  await app.evaluate(({ dialog }) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] });
  });
  const result = await page.evaluate(async () => {
    const reject = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => String(e));
    return {
      badScheme: await reject(window.qa.builds.buildProject({ app: "demo", scheme: "Demo\nrm", configuration: "Debug" })),
      badApp: await reject(window.qa.builds.projectStatus({ app: "../x" })),
      canceled: await window.qa.builds.linkProject({ app: "demo" }),
      status: await window.qa.builds.projectStatus({ app: "demo" }),
      unlinked: await reject(window.qa.builds.buildProject({ app: "demo", scheme: "Demo", configuration: "Debug" })),
    };
  });
  expect(result.badScheme).toContain("invalid-input");
  expect(result.badApp).toContain("invalid-input");
  expect(result.canceled).toBeNull();
  expect(result.status).toEqual({ app: "demo", ios: null });
  expect(result.unlinked).toContain("프로젝트를 먼저 연결한다");
  await app.close();
});
