import { describe, expect, it } from "vitest";
import type { CommandRunner } from "./command";
import { createMaestroSyntaxCheck } from "./maestro-syntax";

function check(result: Awaited<ReturnType<CommandRunner>>, tools: { bin: string | null; java: string | null } = { bin: "/tools/maestro/bin/maestro", java: "/tools/jre" }) {
  const calls: { file: string; args: readonly string[]; input: string | undefined; env: NodeJS.ProcessEnv | undefined }[] = [];
  const run: CommandRunner = (file, args, opts) => {
    calls.push({ file, args, input: opts?.input, env: opts?.env });
    return Promise.resolve(result);
  };
  return { calls, check: createMaestroSyntaxCheck({ run, maestroBin: () => tools.bin, javaHome: () => tools.java, home: "/Users/qa" }) };
}

describe("createMaestroSyntaxCheck", () => {
  it("앱이 관리하는 Maestro 로 check-syntax 에 내용을 표준 입력으로 넘기고, OK 면 통과한다", async () => {
    const { calls, check: run } = check({ code: 0, stdout: "\nOK\n", stderr: "" });
    await expect(run("appId: ${APP_ID}\n---\n- launchApp\n")).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        file: "/tools/maestro/bin/maestro",
        args: ["check-syntax", "-"],
        input: "appId: ${APP_ID}\n---\n- launchApp\n",
        env: expect.objectContaining({ JAVA_HOME: "/tools/jre", HOME: "/Users/qa", MAESTRO_CLI_NO_ANALYTICS: "true", MAESTRO_DISABLE_UPDATE_CHECK: "true" }),
      },
    ]);
  });

  it("문법 오류는 Maestro 의 이유를 편집기 행·열로 바꿔 던진다", async () => {
    const { check: run } = check({ code: 1, stdout: "\n", stderr: "Invalid Command: tapOnn at /syntax-checker:3:9\n" });
    await expect(run("x")).rejects.toThrow("Maestro 문법 오류: Invalid Command: tapOnn (3행 9열)");
  });

  it("실행하지 못했거나 이유가 없으면 그대로 실패로 알린다(통과로 바꾸지 않는다)", async () => {
    await expect(check({ code: -1, stdout: "", stderr: "spawn ENOENT" }).check("x")).rejects.toThrow("Maestro 문법 오류: spawn ENOENT");
    await expect(check({ code: 2, stdout: "", stderr: "" }).check("x")).rejects.toThrow("Maestro 문법 오류: 종료 코드 2");
    await expect(check({ code: 0, stdout: "9.9.9", stderr: "" }).check("x")).rejects.toThrow("Maestro 문법 오류: 9.9.9");
  });

  it("Maestro·JRE 가 없으면 검사하지 않고 설치하라고 알린다", async () => {
    const { calls, check: run } = check({ code: 0, stdout: "OK", stderr: "" }, { bin: null, java: "/tools/jre" });
    await expect(run("x")).rejects.toThrow("Maestro·JRE 가 설치되지 않아 문법을 검사할 수 없다");
    expect(calls).toEqual([]);
  });
});
