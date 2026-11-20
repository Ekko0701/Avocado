import type { CliInfo } from "@qa/shared";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** 셸 작은따옴표 안에 넣을 수 있게 감싼다(앱 경로에 따옴표가 있어도 명령이 깨지지 않게) */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // 깨진 링크다. 다른 것을 가리키는 것으로 본다
    return null;
  }
}

/**
 * 설정의 "터미널" 구역이 보일 것(T-122, D19). 앱은 읽기만 한다: 번들의 명령이 있는지, ~/.local/bin/avocado 가 그것을 가리키는지.
 * 거는 명령은 사람이 터미널에서 실행한다(앱 데이터 밖에 쓰지 않는다)
 */
export function cliInfo(options: { packaged: boolean; resourcesPath: string; home: string }): CliInfo {
  const scriptPath = join(options.resourcesPath, "bin", "avocado");
  const available = options.packaged && existsSync(scriptPath);
  const linkPath = join(options.home, ".local", "bin", "avocado");
  let link: CliInfo["link"];
  try {
    lstatSync(linkPath);
    link = available && realOrNull(linkPath) === realpathSync(scriptPath) ? "this" : "other";
  } catch {
    // 거는 자리에 아무것도 없다
    link = "none";
  }
  return {
    available,
    scriptPath: available ? scriptPath : null,
    linkPath: linkPath.replace(options.home, "~"),
    link,
    linkCommand: available ? `mkdir -p ~/.local/bin && ln -sf ${quote(scriptPath)} ~/.local/bin/avocado` : null,
  };
}
