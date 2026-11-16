import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testcaseTemplate } from "../../../packages/workspace/src/model";
import { startFakeWorkspaceRemote } from "../test-support/fake-workspace";
import { launchApp } from "./launch";

const TOKEN = "github_pat_E2ELOCAL_0123456789abcdefghijklmnopqr";

test("로컬 워크스페이스: 토큰 없는 새 앱 데이터에서 첫 앱 등록, TC 저장, 플로우가 있는 TC 까지 GitHub 에 닿지 않고 된다 (T-124, ADR 0036)", async () => {
  // 앱이 GitHub API 나 git 원격을 부르면 이 가짜 서버들에 기록된다. 토큰은 앱에 넣지 않는다
  const remote = await startFakeWorkspaceRemote(TOKEN);
  try {
    const { app, page, userDataDir } = await launchApp({ env: remote.env, workspaceSource: "local" });
    const localDir = join(userDataDir, "local-workspace");

    expect((await page.evaluate(() => window.qa.settings.get())).settings.workspace).toEqual({ source: "local" });
    expect((await page.evaluate(() => window.qa.secrets.list())).items.find((i) => i.name === "githubToken")).toMatchObject({ stored: false });
    const status = await page.evaluate(() => window.qa.workspace.status());
    expect(status).toMatchObject({ source: "local", connected: true, repo: null, branch: "main", onMain: true, dirty: [], ahead: 0, behind: 0, issues: 0, layout: 2 });
    expect(await page.evaluate(() => window.qa.workspace.testcases())).toEqual({ testcases: [], apps: [], issues: [] });

    const created = await page.evaluate(() =>
      window.qa.workspace.saveApp({ app: "first", create: true, name: "First", locale: null, targets: [{ target: "ios", appId: "com.example.first" }], roles: [], summary: "first app" }),
    );
    expect(created.branch).toBe("main");
    expect((await page.evaluate(() => window.qa.workspace.subflows({ app: "first" }))).subflows.map((s) => s.name)).toEqual(["close-keyboard.yaml", "dismiss-system-prompts.yaml", "launch-clean.yaml"]);

    const text = testcaseTemplate({ id: "TC-0001", app: "first", targets: ["ios"] });
    const saved = await page.evaluate((tc) => window.qa.workspace.saveTestcase({ app: "first", id: "TC-0001", text: tc, summary: "new tc" }), text);
    expect(saved).toMatchObject({ branch: "main", status: { source: "local", branch: "main", dirty: [] } });
    expect((await page.evaluate(() => window.qa.workspace.testcases())).testcases).toMatchObject([{ app: "first", id: "TC-0001", valid: true, flows: [] }]);

    // 플로우 파일을 로컬 워크스페이스 폴더에 두면 그 타깃의 플로우가 있는 TC 로 보인다(승인 단계가 없다)
    const flowDir = join(localDir, "apps", "first", "flows", "ios");
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, "TC-0001.yaml"), ['appId: ${APP_ID}', "name: TC-0001 첫 화면", "tags: [TC-0001]", "---", "- runFlow: common/launch-clean.yaml", '- assertVisible: "시작"', ""].join("\n"));
    const list = await page.evaluate(() => window.qa.workspace.testcases());
    expect(list.issues).toEqual([]);
    expect(list.testcases).toMatchObject([{ app: "first", id: "TC-0001", valid: true, flows: ["ios"] }]);

    // 실행 서비스는 로컬 워크스페이스의 플로우를 믿는다: 플로우 허용 검사를 지나 다음 검사(도구 설치)에서 멈춘다. 밖의 파일은 허용 검사에서 막힌다
    const startRun = (flowPath: string) =>
      page.evaluate(
        (path) =>
          window.qa.runs.start({ app: "first", flowPath: path, deviceId: "no-device", buildId: null }).then(
            () => "",
            (e: unknown) => String(e),
          ),
        flowPath,
      );
    expect(await startRun(join(flowDir, "TC-0001.yaml"))).toContain("설치되지 않았다");
    writeFileSync(join(userDataDir, "outside.yaml"), "appId: com.example.first\n---\n- launchApp\n");
    expect(await startRun(join(userDataDir, "outside.yaml"))).toContain("워크스페이스에 있는 플로우만 실행할 수 있다");

    // Git 화면이 읽는 목록은 비어 있고, 원격이 필요한 기능은 거절된다
    expect(await page.evaluate(() => window.qa.workspace.branches())).toEqual({ current: "main", branches: [] });
    expect(await page.evaluate(() => window.qa.workspace.myPulls())).toEqual([]);
    const refused = await page.evaluate(() =>
      window.qa.workspace.sync().then(
        () => "",
        (e: unknown) => String(e),
      ),
    );
    expect(refused).toContain("로컬 워크스페이스에서는 쓸 수 없다");

    // 출처를 GitHub 로 바꿨다 돌아와도 로컬 내용은 그대로다. 출처는 설정 파일에 남는다
    expect(await page.evaluate(() => window.qa.workspace.setSource({ source: "github" }))).toMatchObject({ source: "github", connected: false, repo: null });
    expect(JSON.parse(readFileSync(join(userDataDir, "settings.json"), "utf8"))).toMatchObject({ workspace: { source: "github" } });
    expect(await page.evaluate(() => window.qa.workspace.setSource({ source: "local" }))).toMatchObject({ source: "local", connected: true, branch: "main" });
    expect((await page.evaluate(() => window.qa.workspace.testcases())).testcases.map((t) => t.id)).toEqual(["TC-0001"]);
    await app.close();

    // 로컬 저장소: main 하나, 원격 없음, 작성자 주소는 GitHub 것이 아니다
    const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: localDir, env: { PATH: "/usr/bin:/bin", HOME: userDataDir, GIT_CONFIG_NOSYSTEM: "1" } }).toString().trim();
    expect(git("log", "--format=%s", "main").split("\n").reverse()).toEqual(["workspace: 로컬 워크스페이스를 만든다", "app: first first app", "tc: TC-0001 new tc"]);
    expect(git("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(git("remote")).toBe("");
    expect(git("log", "--format=%ae")).not.toContain("github.com");
    expect(existsSync(join(userDataDir, "workspaces"))).toBe(false);

    // 이 여정 동안 가짜 GitHub API 가 받은 요청(경로 무관 전부)과 git HTTP 서버가 받은 요청(인증 성공·실패 모두)이 0건이다
    expect(remote.api.requests).toEqual([]);
    expect(remote.gitServer.seen).toEqual({ authorized: 0, rejected: 0 });
  } finally {
    await remote.close();
  }
});
