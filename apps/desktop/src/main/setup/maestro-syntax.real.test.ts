import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lintSubflow } from "@qa/workspace";
import { runCommand } from "./command";
import { createMaestroSyntaxCheck } from "./maestro-syntax";

// 실제 Maestro(앱이 관리하는 2.11.0)의 check-syntax 로 확인한다. 기기는 필요 없다.
// QA_REAL_MAESTRO_SYNTAX=1 QA_MAESTRO_BIN=<…/maestro/bin/maestro> QA_JAVA_HOME=<…/Contents/Home>
const bin = process.env["QA_MAESTRO_BIN"];
const javaHome = process.env["QA_JAVA_HOME"];
const enabled = process.env["QA_REAL_MAESTRO_SYNTAX"] === "1" && bin && javaHome;
const home = mkdtempSync(join(tmpdir(), "qa-maestro-syntax-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.skipIf(!enabled)("Maestro check-syntax (실제 Maestro)", { timeout: 60_000 }, () => {
  const check = createMaestroSyntaxCheck({ run: runCommand, maestroBin: () => bin ?? null, javaHome: () => javaHome ?? null, home });
  const head = "appId: ${APP_ID}\n---\n";

  it("규약에 맞는 서브플로우는 통과한다", async () => {
    await expect(check(`${head}- clearKeychain\n- launchApp:\n    clearState: true\n- extendedWaitUntil:\n    visible: "로그인"\n    timeout: 15000\n- runFlow: close-keyboard.yaml\n`)).resolves.toBeUndefined();
  });

  it("없는 명령과 없는 옵션은 행·열과 함께 막는다", async () => {
    await expect(check(`${head}- launchApp\n- tapOnn: "닫기"\n`)).rejects.toThrow(/^Maestro 문법 오류: .*tapOnn.*\(4행 \d+열\)/);
    await expect(check(`${head}- launchApp:\n    clearStatee: true\n`)).rejects.toThrow(/^Maestro 문법 오류: /);
  });

  it("조건 없는 extendedWaitUntil 은 check-syntax 가 통과시키므로 규약 검사(lintSubflow)가 막는다", async () => {
    const text = `${head}- extendedWaitUntil:\n    timeout: 30000\n`;
    await expect(check(text)).resolves.toBeUndefined();
    expect(lintSubflow(text, { envKeys: [], subflows: [] }).map((i) => i.rule)).toEqual(["flow-syntax"]);
  });
});
