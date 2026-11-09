import type { CommandRunner } from "./command";
import { maestroEnv } from "./setup-service";

/**
 * 앱이 관리하는 Maestro 의 `check-syntax -` 로 플로우 YAML 을 검사한다(표준 입력, 기기 없이).
 * 없는 명령·옵션 이름·값 형식을 잡는다. 문법 오류나 검사 실패면 이유를 담아 던진다. 통과하면 아무것도 돌려주지 않는다
 */
export function createMaestroSyntaxCheck(options: {
  run: CommandRunner;
  maestroBin: () => string | null;
  javaHome: () => string | null;
  /** maestroEnv 의 HOME */
  home: string;
}): (text: string) => Promise<void> {
  return async (text) => {
    const bin = options.maestroBin();
    const javaHome = options.javaHome();
    if (!bin || !javaHome) throw new Error("Maestro·JRE 가 설치되지 않아 문법을 검사할 수 없다. 설정 마법사에서 설치한다");
    const r = await options.run(bin, ["check-syntax", "-"], { input: text, env: maestroEnv(javaHome, options.home), timeoutMs: 60_000 });
    if (r.code === 0 && r.stdout.trim().endsWith("OK")) return;
    // 표준 입력이라 위치가 "/syntax-checker:<행>:<열>" 로 온다. 편집기의 행과 같다
    const reason = (r.stderr.trim() || r.stdout.trim()).replace(/ at \/syntax-checker:(\d+):(\d+)/g, " ($1행 $2열)");
    throw new Error(`Maestro 문법 오류: ${reason || `종료 코드 ${r.code}`}`);
  };
}
