import { AppIdSchema } from "@qa/shared";

/** avocado 명령 하나(ADR 0029·0035). 판단(기기 고르기, 플로우 찾기)은 앱이 한다. 여기서는 모양만 본다 */
export type Command =
  | { kind: "run"; app: string; tcIds?: string[]; tag?: string; target?: "ios" | "android"; device?: string; build?: string; json: boolean }
  | { kind: "status"; batchId: string; json: boolean; follow: boolean }
  | { kind: "cancel"; batchId: string; json: boolean }
  | { kind: "options"; json: boolean }
  | { kind: "help" };

export class ArgError extends Error {}

export const USAGE = `사용법:
  avocado qa run <앱>-TC-<번호>… [--target ios|android] [--device <id>] [--build <id>] [--json]
  avocado qa run --app <앱> --tag <태그> [--target …] [--device …] [--build …] [--json]
  avocado qa status <묶음 id> [--no-wait] [--json]
  avocado qa cancel <묶음 id> [--json]
  avocado qa options [--json]

테스트 케이스는 demo-TC-0101 또는 demo/TC-0101 로 쓴다. Avocado 앱이 켜져 있어야 한다.
종료 코드: 0 모두 통과, 1 실패, 2 인자 오류, 3 앱에 연결하지 못함, 4 취소, 5 플로우가 없어 돌리지 않은 TC 가 있음, 6 시작하지 못했거나 오류`;

/** demo-TC-0101, demo/TC-0101. 앱 id 에 하이픈이 있을 수 있어 마지막 -TC- 로 나눈다 */
export function parseTestcaseRef(ref: string): { app: string; tcId: string } {
  const m = /^(.+?)(?:\/|-)(TC-\d{4,})$/.exec(ref);
  if (!m?.[1] || !m[2] || !AppIdSchema.safeParse(m[1]).success) throw new ArgError(`테스트 케이스는 <앱>-TC-<번호> 로 쓴다(예: demo-TC-0101): ${ref}`);
  return { app: m[1], tcId: m[2] };
}

const VALUE_FLAGS = new Set(["--target", "--device", "--build", "--tag", "--app"]);
const BOOL_FLAGS = new Set(["--json", "--no-wait"]);

function split(argv: string[]): { positional: string[]; values: Map<string, string>; bools: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOL_FLAGS.has(name)) {
      if (eq > 0) throw new ArgError(`${name} 는 값을 받지 않는다`);
      bools.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[(i += 1)];
      if (!value || value.startsWith("--")) throw new ArgError(`${name} 에 값이 없다`);
      if (values.has(name)) throw new ArgError(`${name} 를 두 번 줬다`);
      values.set(name, value);
    } else {
      throw new ArgError(`모르는 옵션이다: ${name}`);
    }
  }
  return { positional, values, bools };
}

function only(flags: { values: Map<string, string>; bools: Set<string> }, allowed: string[], command: string): void {
  for (const name of [...flags.values.keys(), ...flags.bools]) if (!allowed.includes(name)) throw new ArgError(`${command} 에는 ${name} 를 쓰지 않는다`);
}

export function parseArgs(argv: string[]): Command {
  if (argv.length === 0) throw new ArgError("명령이 없다");
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") return { kind: "help" };
  const [group, command, ...rest] = argv;
  if (group !== "qa") throw new ArgError(`모르는 명령이다: ${group ?? ""}. avocado qa … 로 쓴다`);
  const flags = split(rest);
  const json = flags.bools.has("--json");
  if (command === "run") {
    only(flags, ["--target", "--device", "--build", "--tag", "--app", "--json"], "run");
    const rawTarget = flags.values.get("--target");
    if (rawTarget !== undefined && rawTarget !== "ios" && rawTarget !== "android") throw new ArgError(`--target 은 ios 나 android: ${rawTarget}`);
    const target: "ios" | "android" | undefined = rawTarget;
    const common = {
      ...(target ? { target } : {}),
      ...(flags.values.has("--device") ? { device: flags.values.get("--device") } : {}),
      ...(flags.values.has("--build") ? { build: flags.values.get("--build") } : {}),
      json,
    };
    const tag = flags.values.get("--tag");
    if (tag !== undefined) {
      if (flags.positional.length > 0) throw new ArgError("--tag 와 테스트 케이스를 같이 주지 않는다");
      const app = flags.values.get("--app");
      if (!app || !AppIdSchema.safeParse(app).success) throw new ArgError("--tag 에는 --app <앱> 이 필요하다");
      return { kind: "run", app, tag, ...common };
    }
    if (flags.values.has("--app")) throw new ArgError("--app 은 --tag 와 같이 쓴다. 테스트 케이스는 <앱>-TC-<번호> 로 쓴다");
    if (flags.positional.length === 0) throw new ArgError("실행할 테스트 케이스가 없다");
    const refs = flags.positional.map(parseTestcaseRef);
    const apps = [...new Set(refs.map((r) => r.app))];
    if (apps.length > 1) throw new ArgError(`한 번에 한 앱만 실행한다: ${apps.join(", ")}`);
    return { kind: "run", app: apps[0] ?? "", tcIds: [...new Set(refs.map((r) => r.tcId))], ...common };
  }
  if (command === "status" || command === "cancel") {
    only(flags, command === "status" ? ["--json", "--no-wait"] : ["--json"], command);
    const [batchId, ...extra] = flags.positional;
    if (!batchId || extra.length > 0) throw new ArgError(`${command} 에는 묶음 id 하나를 준다`);
    return command === "status" ? { kind: "status", batchId, json, follow: !flags.bools.has("--no-wait") } : { kind: "cancel", batchId, json };
  }
  if (command === "options") {
    only(flags, ["--json"], "options");
    if (flags.positional.length > 0) throw new ArgError("options 는 인자를 받지 않는다");
    return { kind: "options", json };
  }
  throw new ArgError(`모르는 명령이다: qa ${command ?? ""}`);
}
