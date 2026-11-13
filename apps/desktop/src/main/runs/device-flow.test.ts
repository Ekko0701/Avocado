import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeProblems, prepareDeviceFlow } from "./device-flow";

let dir: string;
let flows: string;
let out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-flow-"));
  flows = join(dir, "flows", "ios");
  out = join(dir, "out");
  mkdirSync(join(flows, "common"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text: string) => writeFileSync(join(flows, rel), text);

describe("prepareDeviceFlow", () => {
  it("지원하는 명령만 쓰면 문제가 없고, 캡처 이름에 .png 를 붙인 사본을 만든다(원본·주석은 그대로)", () => {
    write(
      "TC-0101.yaml",
      [
        "# 메모",
        "appId: ${APP_ID}",
        "name: TC-0101",
        "---",
        "- runFlow: common/open.yaml",
        "- tapOn:",
        '    id: "login"',
        "- inputText: ${DEMO_ID}",
        "- takeScreenshot: 01_home",
        "- takeScreenshot:",
        "    path: 02_done.png",
        "",
      ].join("\n"),
    );
    write("common/open.yaml", "appId: ${APP_ID}\n---\n- launchApp\n- takeScreenshot: 00_open\n");
    const r = prepareDeviceFlow(join(flows, "TC-0101.yaml"), out);
    expect(r.problems).toEqual([]);
    expect(r.renamedScreenshots).toBe(2);
    expect(r.flowPath).toBe(join(out, "TC-0101.yaml"));
    const copy = readFileSync(r.flowPath, "utf8");
    expect(copy).toContain("# 메모");
    expect(copy).toContain("takeScreenshot: 01_home.png");
    expect(copy).toContain("path: 02_done.png");
    expect(readFileSync(join(out, "common", "open.yaml"), "utf8")).toContain("takeScreenshot: 00_open.png");
    expect(readFileSync(join(flows, "TC-0101.yaml"), "utf8")).toContain("takeScreenshot: 01_home\n");
  });

  it("실기기에서 못 쓰는 명령을 서브플로우까지 찾아 파일·줄과 함께 알린다", () => {
    write("TC-0102.yaml", "appId: ${APP_ID}\n---\n- runFlow: common/launch-clean.yaml\n- inputRandomEmail\n- repeat:\n    times: 2\n    commands:\n      - setLocation:\n          latitude: 1\n          longitude: 2\n");
    write("common/launch-clean.yaml", "appId: ${APP_ID}\n---\n- launchApp:\n    clearState: true\n    permissions:\n      all: allow\n- clearKeychain\n");
    const r = prepareDeviceFlow(join(flows, "TC-0102.yaml"), out);
    expect(r.problems.map((p) => [p.file, p.line, p.command])).toEqual([
      ["common/launch-clean.yaml", 3, "launchApp.clearState"],
      ["common/launch-clean.yaml", 3, "launchApp.permissions"],
      ["common/launch-clean.yaml", 7, "clearKeychain"],
      ["TC-0102.yaml", 4, "inputRandomEmail"],
      ["TC-0102.yaml", 8, "setLocation"],
    ]);
    expect(describeProblems(r.problems)).toMatch(/^iOS 실기기에서 재생할 수 없는 명령이 있다: common\/launch-clean.yaml:3 launchApp.clearState\(iOS 실기기에서는 앱 데이터를 지울 수 없다\)/);
  });

  it("플로우 폴더 밖이나 없는 서브플로우는 문제로 본다", () => {
    writeFileSync(join(dir, "flows", "outside.yaml"), "appId: x\n---\n- launchApp\n");
    write("TC-0103.yaml", "appId: x\n---\n- runFlow: ../outside.yaml\n- runFlow:\n    file: common/none.yaml\n");
    const r = prepareDeviceFlow(join(flows, "TC-0103.yaml"), out);
    expect(r.problems.map((p) => p.reason)).toEqual(["서브플로우가 플로우 폴더 밖에 있다", "서브플로우 파일이 없다"]);
  });

  it("onFlowStart 의 명령도 본다", () => {
    write("TC-0104.yaml", "appId: x\nonFlowStart:\n  - clearState\n---\n- launchApp\n");
    expect(prepareDeviceFlow(join(flows, "TC-0104.yaml"), out).problems.map((p) => p.command)).toEqual(["clearState"]);
  });
});
