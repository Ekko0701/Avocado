import type { TransferItem } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ImportPickError, planImport, type FileTree, type ImportPlan } from "./engine";

const enc = new TextEncoder();
const dec = new TextDecoder();
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files).map(([p, t]) => [p, enc.encode(t)]));
const text = (files: Map<string, Uint8Array>, path: string) => {
  const bytes = files.get(path);
  return bytes ? dec.decode(bytes) : undefined;
};

const wsYaml = (apps: string[]) => `# 워크스페이스 설정\nschemaVersion: 2\nname: ws\napps: [${apps.join(", ")}]\n`;
const appYaml = (name: string, targets: Record<string, string>) => `# ${name} 앱 설정\nname: ${name}\ntargets:\n${Object.entries(targets).map(([t, id]) => `  ${t}:\n    appId: ${id}\n`).join("")}`;
const tcMd = (id: string, app: string, title: string, opts: { targets?: string[]; account?: string; step?: string } = {}) =>
  [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `app: ${app}`,
    `targets: [${(opts.targets ?? ["ios"]).join(", ")}]`,
    `tags: [smoke]`,
    ...(opts.account ? [`account: ${opts.account}`] : []),
    "status: active",
    "---",
    "## 전제조건",
    "- 앱을 처음 연다",
    "",
    "## 스텝",
    `1. ${opts.step ?? "'새 메모'를 탭한다"}`,
    "   - 기대: 편집 화면이 보인다",
    "",
    "## 완료 기준",
    "- 편집 화면이 보인다",
    "",
  ].join("\n");
const flow = (id: string, body: string[] = ['- assertVisible: "편집"']) =>
  ["# 받은 플로우", "appId: ${APP_ID}", `name: "${id} 새 메모"`, `tags: [${id}, smoke]`, "---", "- runFlow: common/launch-clean.yaml", ...body, ""].join("\n");
const meta = (id: string, target = "ios") => `tc: ${id}\ntcVersion: abc1234\ntarget: ${target}\ngeneratedBy: human\n`;
const SUB = "appId: ${APP_ID}\n---\n- launchApp:\n    clearState: true\n";

/** 받는 쪽: settings 앱(iOS), TC-0001 과 그 플로우, 공통 서브플로우 하나 */
const RECEIVING = {
  "workspace.yaml": wsYaml(["settings"]),
  "apps/settings/app.yaml": appYaml("Settings", { ios: "com.apple.Preferences" }),
  "apps/settings/testcases/TC-0001.md": tcMd("TC-0001", "settings", "설정 앱을 열면 첫 화면이 보인다"),
  "apps/settings/flows/ios/TC-0001.yaml": flow("TC-0001"),
  "apps/settings/flows/ios/common/launch-clean.yaml": SUB,
};

function fakeChecks() {
  const calls: string[] = [];
  return {
    calls,
    checks: {
      checkFlowSyntax: (t: string) => {
        calls.push(t);
        return t.includes("tapOnn") ? Promise.reject(new Error("Maestro 문법 오류: Invalid Command: tapOnn (7행 3열)")) : Promise.resolve();
      },
    },
  };
}

async function plan(incoming: Record<string, string>, receiving: Record<string, string> = RECEIVING): Promise<ImportPlan> {
  const r = await planImport({ incoming: tree({ "workspace.yaml": wsYaml([]), ...incoming }), receiving: tree(receiving), checks: fakeChecks().checks });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.plan;
}
const item = (p: ImportPlan, key: string): TransferItem => {
  const found = p.items.find((i) => i.key === key);
  if (!found) throw new Error(`없는 항목: ${key} (${p.items.map((i) => i.key).join(", ")})`);
  return found;
};
const defaults = (p: ImportPlan) => p.items.flatMap((i) => (i.defaultChoice ? [{ key: i.key, action: i.defaultChoice }] : []));

/** 받은 쪽: 새 앱 notes(iOS), TC-0001(받는 쪽 번호와 겹침)·TC-0002, 공통 서브플로우 */
const NOTES = {
  "apps/notes/app.yaml": appYaml("Notes", { ios: "com.example.notes" }),
  "apps/notes/testcases/TC-0001.md": tcMd("TC-0001", "notes", "새 메모를 만든다"),
  "apps/notes/flows/ios/TC-0001.yaml": flow("TC-0001"),
  "apps/notes/flows/ios/TC-0001.meta.yaml": meta("TC-0001"),
  "apps/notes/testcases/TC-0002.md": tcMd("TC-0002", "notes", "메모를 지운다"),
  "apps/notes/flows/ios/TC-0002.yaml": flow("TC-0002"),
  "apps/notes/flows/ios/common/launch-clean.yaml": SUB,
};

describe("견주기와 번호", () => {
  it("새 앱과 그 테스트 케이스: 새로 생김, 다른 앱의 번호와 겹치면 새 번호, 서브플로우가 따라온다", async () => {
    const p = await plan(NOTES);
    expect(p.items.map((i) => [i.key, i.status, i.defaultChoice])).toEqual([
      ["app:notes", "new", "include"],
      ["testcase:notes:TC-0001", "renumber", "renumber"],
      ["testcase:notes:TC-0002", "new", "include"],
      ["subflow:notes:ios:launch-clean.yaml", "new", "include"],
    ]);
    expect(item(p, "testcase:notes:TC-0001")).toMatchObject({ label: "TC-0001 → TC-0003 새 메모를 만든다", detail: "notes · 플로우 iOS", renumberTo: "TC-0003" });
    expect(item(p, "testcase:notes:TC-0001").note).toContain("이 워크스페이스의 TC-0001(설정 앱을 열면 첫 화면이 보인다)과 다른 테스트입니다");
    expect(item(p, "testcase:notes:TC-0002").requires).toEqual(["app:notes", "subflow:notes:ios:launch-clean.yaml"]);
    expect(item(p, "subflow:notes:ios:launch-clean.yaml").note).toBe("TC-0002, TC-0003 의 플로우가 부릅니다.");
    expect(p.summary).toEqual({ new: 3, renumber: 1, differs: 0, same: 0, rejected: 0 });
  });

  it("새 번호로 가져오면 파일 이름·머리말 id·플로우 name 과 tags·meta tc 만 바뀌고 나머지 글자는 그대로다", async () => {
    const p = await plan(NOTES);
    const w = p.apply(defaults(p));
    expect(w.renumbered).toEqual([{ from: "TC-0001", to: "TC-0003" }]);
    expect(text(w.files, "apps/notes/testcases/TC-0003.md")).toBe(tcMd("TC-0003", "notes", "새 메모를 만든다"));
    expect(text(w.files, "apps/notes/flows/ios/TC-0003.yaml")).toBe(flow("TC-0003"));
    expect(text(w.files, "apps/notes/flows/ios/TC-0003.meta.yaml")).toBe(meta("TC-0003"));
    expect([...w.files.keys()].some((k) => k.includes("notes/testcases/TC-0001") || k.includes("ios/TC-0001."))).toBe(false);
    // 번호가 겹치지 않은 것은 받은 바이트 그대로다
    expect(text(w.files, "apps/notes/testcases/TC-0002.md")).toBe(NOTES["apps/notes/testcases/TC-0002.md"]);
    // 새 앱은 workspace.yaml 앱 목록에 더하고 주석은 그대로 둔다
    expect(text(w.files, "workspace.yaml")).toBe("# 워크스페이스 설정\nschemaVersion: 2\nname: ws\napps: [settings, notes]\n");
  });

  it("같은 앱·같은 번호: 내용이 같으면 같음, 다르면 내용 다름(처음에는 고르지 않음). 같은 테스트를 고르면 덮어쓴다", async () => {
    const same = await plan({ "apps/settings/testcases/TC-0001.md": RECEIVING["apps/settings/testcases/TC-0001.md"], "apps/settings/flows/ios/TC-0001.yaml": RECEIVING["apps/settings/flows/ios/TC-0001.yaml"] });
    expect(item(same, "testcase:settings:TC-0001")).toMatchObject({ status: "same", choices: [], defaultChoice: null, note: "이 워크스페이스와 내용이 같습니다" });

    const changed = tcMd("TC-0001", "settings", "설정 앱을 열면 첫 화면이 보인다", { step: "'일반'을 탭한다" });
    const p = await plan({ "apps/settings/testcases/TC-0001.md": changed, "apps/settings/flows/ios/TC-0001.yaml": RECEIVING["apps/settings/flows/ios/TC-0001.yaml"] });
    const tc = item(p, "testcase:settings:TC-0001");
    expect(tc).toMatchObject({ status: "differs", choices: ["overwrite", "renumber"], defaultChoice: null, renumberTo: "TC-0002" });
    expect(tc.note).toBe("같은 앱, 같은 번호입니다. 테스트 케이스가 다릅니다.");
    expect(tc.compare.map((c) => c.path)).toEqual(["apps/settings/testcases/TC-0001.md"]);
    expect(() => p.apply([])).toThrow(ImportPickError);
    const overwrite = p.apply([{ key: tc.key, action: "overwrite" }]);
    expect([...overwrite.files.keys()].sort()).toEqual(["apps/settings/flows/ios/TC-0001.yaml", "apps/settings/testcases/TC-0001.md"]);
    expect(text(overwrite.files, "apps/settings/testcases/TC-0001.md")).toBe(changed);
    const renumber = p.apply([{ key: tc.key, action: "renumber" }]);
    expect([...renumber.files.keys()].sort()).toEqual(["apps/settings/flows/ios/TC-0002.yaml", "apps/settings/testcases/TC-0002.md"]);
  });

  it("덮어쓰기는 앱과 번호가 같을 때만 고를 수 있다", async () => {
    const p = await plan(NOTES);
    expect(() => p.apply([{ key: "testcase:notes:TC-0001", action: "overwrite" }])).toThrow(/고를 수 없는 할 일/);
  });

  it("이번 가져오기 안에서 두 앱의 번호가 겹치면 뒤의 것을 새 번호로 넣는다", async () => {
    const p = await plan({
      ...NOTES,
      "apps/notes/testcases/TC-0001.md": tcMd("TC-0001", "notes", "새 메모"),
      "apps/memo/app.yaml": appYaml("Memo", { ios: "com.example.memo" }),
      "apps/memo/testcases/TC-0009.md": tcMd("TC-0009", "memo", "메모 A"),
      "apps/notes/testcases/TC-0009.md": tcMd("TC-0009", "notes", "메모 B"),
    });
    expect(item(p, "testcase:memo:TC-0009").status).toBe("new");
    expect(item(p, "testcase:notes:TC-0009")).toMatchObject({ status: "renumber", renumberTo: "TC-0011" });
    expect(item(p, "testcase:notes:TC-0009").note).toContain("번호가 겹쳐 새 번호(TC-0011)로");
    expect(item(p, "testcase:notes:TC-0001").renumberTo).toBe("TC-0010");
  });

  it("미리보기에 없는 항목, 두 번 고른 항목, 받지 않는 항목은 고를 수 없다", async () => {
    const p = await plan({ ...NOTES, "apps/notes/testcases/TC-0004.md": "---\nid: TC-0004\n---\n" });
    expect(item(p, "testcase:notes:TC-0004").status).toBe("rejected");
    expect(() => p.apply([{ key: "testcase:notes:TC-0099", action: "include" }])).toThrow(/미리보기에 없는 항목/);
    expect(() => p.apply([{ key: "testcase:notes:TC-0004", action: "include" }])).toThrow(/고를 수 없는 할 일/);
    expect(() =>
      p.apply([
        { key: "app:notes", action: "include" },
        { key: "app:notes", action: "include" },
      ]),
    ).toThrow(/두 번/);
  });
});

describe("따라오는 것", () => {
  const CHAIN = {
    ...NOTES,
    "apps/notes/flows/ios/TC-0002.yaml": ["appId: ${APP_ID}", "name: TC-0002 x", "tags: [TC-0002]", "---", "- runFlow: common/launch-clean.yaml", "- runFlow: common/login.yaml", '- assertVisible: "x"', ""].join("\n"),
    "apps/notes/flows/ios/common/login.yaml": "appId: ${APP_ID}\n---\n- runFlow: close-keyboard.yaml\n",
    "apps/notes/flows/ios/common/close-keyboard.yaml": "appId: ${APP_ID}\n---\n- hideKeyboard\n",
  };

  it("플로우가 부르는 서브플로우와 그 서브플로우가 부르는 것까지 함께 들어간다", async () => {
    const p = await plan(CHAIN);
    expect(item(p, "testcase:notes:TC-0002").requires).toEqual(["app:notes", "subflow:notes:ios:close-keyboard.yaml", "subflow:notes:ios:launch-clean.yaml", "subflow:notes:ios:login.yaml"]);
    expect(item(p, "subflow:notes:ios:close-keyboard.yaml").note).toBe("TC-0002 의 플로우가 부릅니다.");
    const w = p.apply([{ key: "testcase:notes:TC-0002", action: "include" }]);
    expect([...w.files.keys()].sort()).toEqual([
      "apps/notes/app.yaml",
      "apps/notes/flows/ios/TC-0002.yaml",
      "apps/notes/flows/ios/common/close-keyboard.yaml",
      "apps/notes/flows/ios/common/launch-clean.yaml",
      "apps/notes/flows/ios/common/login.yaml",
      "apps/notes/testcases/TC-0002.md",
      "workspace.yaml",
    ]);
  });

  it("받는 쪽과 내용이 다른 서브플로우는 고르기 전에는 반영하지 않는다(처음 값은 이쪽 것 그대로)", async () => {
    const theirs = `${SUB}- tapOn:\n    text: "허용"\n    optional: true\n`;
    const p = await plan({
      "apps/settings/testcases/TC-0005.md": tcMd("TC-0005", "settings", "새 화면"),
      "apps/settings/flows/ios/TC-0005.yaml": flow("TC-0005"),
      "apps/settings/flows/ios/common/launch-clean.yaml": theirs,
    });
    const sub = item(p, "subflow:settings:ios:launch-clean.yaml");
    expect(sub).toMatchObject({ status: "differs", choices: ["keep-ours", "take-theirs"], defaultChoice: "keep-ours", note: "TC-0005 의 플로우가 부릅니다. 내용이 다릅니다" });
    expect(sub.compare).toEqual([{ path: "apps/settings/flows/ios/common/launch-clean.yaml", ours: SUB, theirs }]);
    expect(item(p, "testcase:settings:TC-0005").requires).toEqual([]);
    const kept = p.apply(defaults(p));
    expect(kept.files.has("apps/settings/flows/ios/common/launch-clean.yaml")).toBe(false);
    const taken = p.apply([{ key: sub.key, action: "take-theirs" }]);
    expect(text(taken.files, "apps/settings/flows/ios/common/launch-clean.yaml")).toBe(theirs);
  });

  it("앱 설정은 더하기만 한다: 받는 쪽의 타깃·역할·키를 지우지 않는다", async () => {
    const receiving = {
      ...RECEIVING,
      "apps/settings/app.yaml": `${appYaml("Settings", { ios: "com.apple.Preferences" })}note: 받는 쪽 메모\n`,
      "apps/settings/accounts.yaml": "# 계정\nadmin:\n  description: 관리자\n  keys: [ADMIN_PW]\nuser:\n  description: 사용자\n  keys: [USER_PW]\n",
    };
    const p = await plan(
      {
        "apps/settings/app.yaml": appYaml("설정", { ios: "com.apple.Preferences", android: "com.android.settings" }),
        "apps/settings/accounts.yaml": "user:\n  description: 다른 설명\n  keys: [USER_ID]\nguest:\n  description: 손님\n  keys: [GUEST_PW]\n",
      },
      receiving,
    );
    const app = item(p, "app:settings");
    expect(app).toMatchObject({ status: "differs", choices: ["include"], defaultChoice: "include" });
    expect(app.note).toBe("가져오면 타깃 android, 역할 guest, 키 USER_ID를 더합니다. 이 워크스페이스의 것은 지우지 않습니다");
    const w = p.apply(defaults(p));
    const merged = parseYaml(text(w.files, "apps/settings/app.yaml") ?? "") as { name: string; note: string; targets: Record<string, { appId: string }> };
    expect(merged).toEqual({ name: "Settings", note: "받는 쪽 메모", targets: { ios: { appId: "com.apple.Preferences" }, android: { appId: "com.android.settings" } } });
    expect(text(w.files, "apps/settings/app.yaml")?.startsWith("# Settings 앱 설정\n")).toBe(true);
    expect(parseYaml(text(w.files, "apps/settings/accounts.yaml") ?? "")).toEqual({
      admin: { description: "관리자", keys: ["ADMIN_PW"] },
      user: { description: "사용자", keys: ["USER_PW", "USER_ID"] },
      guest: { description: "손님", keys: ["GUEST_PW"] },
    });
  });

  it("같은 타깃의 앱 ID 가 다르면 내용 다름이고 처음 값은 이쪽 것 그대로다", async () => {
    const p = await plan({ "apps/settings/app.yaml": appYaml("Settings", { ios: "com.example.other", android: "com.android.settings" }) });
    const app = item(p, "app:settings");
    expect(app).toMatchObject({ status: "differs", choices: ["keep-ours", "take-theirs"], defaultChoice: "keep-ours" });
    expect(app.note).toContain("ios 앱 ID 가 다릅니다(이 워크스페이스 com.apple.Preferences, 받은 것 com.example.other)");
    const keep = parseYaml(text(p.apply([{ key: app.key, action: "keep-ours" }]).files, "apps/settings/app.yaml") ?? "") as { targets: Record<string, { appId: string }> };
    expect(keep.targets).toEqual({ ios: { appId: "com.apple.Preferences" }, android: { appId: "com.android.settings" } });
    const take = parseYaml(text(p.apply([{ key: app.key, action: "take-theirs" }]).files, "apps/settings/app.yaml") ?? "") as { targets: Record<string, { appId: string }> };
    expect(take.targets.ios).toEqual({ appId: "com.example.other" });
  });

  it("받는 쪽 앱에 없는 타깃의 테스트 케이스는 앱 설정과 함께만 들어간다. 받은 묶음에 앱 설정이 없으면 받지 않는다", async () => {
    const tc = { "apps/settings/testcases/TC-0007.md": tcMd("TC-0007", "settings", "안드로이드", { targets: ["android"] }), "apps/settings/flows/android/TC-0007.yaml": flow("TC-0007") };
    const without = await plan(tc);
    expect(item(without, "testcase:settings:TC-0007")).toMatchObject({ status: "rejected" });
    expect(item(without, "testcase:settings:TC-0007").note).toContain("받은 묶음에 앱 설정이 없습니다");
    const p = await plan({ ...tc, "apps/settings/app.yaml": appYaml("Settings", { ios: "com.apple.Preferences", android: "com.android.settings" }), "apps/settings/flows/android/common/launch-clean.yaml": SUB });
    expect(item(p, "testcase:settings:TC-0007").requires).toEqual(["app:settings", "subflow:settings:android:launch-clean.yaml"]);
    const w = p.apply([{ key: "testcase:settings:TC-0007", action: "include" }]);
    expect(w.picked.map((x) => `${x.item.key}=${x.action}`).sort()).toEqual(["app:settings=include", "subflow:settings:android:launch-clean.yaml=include", "testcase:settings:TC-0007=include"]);
    expect(text(w.files, "apps/settings/app.yaml")).toContain("android:");
  });
});

describe("받는 검사", () => {
  it("린트 오류가 있는 플로우는 받지 않고 줄 번호와 이유가 나온다", async () => {
    const p = await plan({ ...NOTES, "apps/notes/flows/ios/TC-0002.yaml": flow("TC-0002", ["- launchApp:", "    appId: com.apple.mobilesafari", '- assertVisible: "x"']) });
    const tc = item(p, "testcase:notes:TC-0002");
    expect(tc.status).toBe("rejected");
    expect(tc.note).toMatch(/^플로우 검사 오류: 8줄 launchApp\.appId 는 \$\{APP_ID\} 로만 둔다/);
    expect(tc.choices).toEqual([]);
  });

  it("Maestro 문법 오류도 받지 않는다. 같은 글자는 한 번만 검사한다", async () => {
    const checks = fakeChecks();
    const incoming = tree({
      "workspace.yaml": wsYaml([]),
      ...NOTES,
      "apps/notes/flows/ios/TC-0002.yaml": flow("TC-0002", ["- tapOnn: x", '- assertVisible: "x"']),
      "apps/notes/flows/ios/common/a.yaml": SUB,
      "apps/notes/flows/ios/common/b.yaml": SUB,
    });
    const r = await planImport({ incoming, receiving: tree(RECEIVING), checks: checks.checks });
    if (!r.ok) throw new Error("plan");
    expect(item(r.plan, "testcase:notes:TC-0002").note).toBe("플로우: Maestro 문법 오류: Invalid Command: tapOnn (7행 3열)");
    expect(checks.calls.filter((c) => c === SUB)).toHaveLength(1);
    expect(new Set(checks.calls).size).toBe(checks.calls.length);
  });

  it("tc 가 파일과 다른 meta, 대문자가 든 서브플로우 이름, 앞부분이 맞지 않는 머리말은 받지 않는다", async () => {
    const p = await plan({
      ...NOTES,
      "apps/notes/flows/ios/TC-0002.meta.yaml": meta("TC-0009"),
      "apps/notes/flows/ios/common/Login.yaml": SUB,
      "apps/notes/testcases/TC-0005.md": tcMd("TC-0006", "notes", "번호 다름"),
    });
    expect(item(p, "testcase:notes:TC-0002").note).toContain("플로우 정보(meta): tc(TC-0009)·target(ios)이 파일 위치(TC-0002, ios)와 다릅니다");
    expect(item(p, "subflow:notes:ios:Login.yaml")).toMatchObject({ status: "rejected", note: "서브플로우 파일 이름은 소문자·숫자·-·_ 와 .yaml 만 받습니다" });
    expect(item(p, "testcase:notes:TC-0005").note).toContain("머리말의 id(TC-0006)가 파일 이름과 다릅니다");
  });

  it("함께 들어가야 하는 서브플로우를 받지 않으면 그 테스트 케이스도 받지 않는다", async () => {
    const p = await plan({ ...NOTES, "apps/notes/flows/ios/common/launch-clean.yaml": "appId: ${APP_ID}\n---\n- runScript: steal.js\n" });
    expect(item(p, "subflow:notes:ios:launch-clean.yaml").status).toBe("rejected");
    expect(item(p, "testcase:notes:TC-0002").note).toBe("함께 들어가야 하는 공통 서브플로우 · launch-clean.yaml을(를) 받지 않아 받지 않습니다");
  });

  it("건너뛴 파일은 이유와 함께 목록에 있다", async () => {
    const p = await plan({
      ...NOTES,
      "README.md": "# 설명",
      "CODEOWNERS": "* @x",
      "apps/notes/flows/ios/TC-0003.yml": flow("TC-0003"),
      "apps/notes/flows/ios/TC-0008.yaml": flow("TC-0008"),
      "apps/notes/flows/web/TC-0002.yaml": flow("TC-0002"),
      "testcases/notes/TC-0001.md": "x",
    });
    expect(p.skipped).toEqual([
      { path: "CODEOWNERS", reason: "워크스페이스 파일이 아닙니다" },
      { path: "README.md", reason: "워크스페이스 파일이 아닙니다" },
      { path: "apps/notes/flows/ios/TC-0003.yml", reason: "플로우 파일 이름은 .yaml 로 끝나야 합니다" },
      { path: "apps/notes/flows/ios/TC-0008.yaml", reason: "테스트 케이스 파일이 없는 플로우입니다" },
      { path: "apps/notes/flows/web/TC-0002.yaml", reason: "타깃 폴더(web)는 ios, android, flutter-ios, flutter-android 중 하나여야 합니다" },
      { path: "testcases/notes/TC-0001.md", reason: "예전 폴더 구조(schemaVersion 1)의 위치입니다" },
    ]);
  });

  it("예전 폴더 구조(schemaVersion 1)나 workspace.yaml 이 없는 묶음은 전체를 받지 않는다", async () => {
    const v1 = await planImport({ incoming: tree({ "workspace.yaml": "schemaVersion: 1\nname: x\napps: [a]\n" }), receiving: tree(RECEIVING), checks: fakeChecks().checks });
    expect(v1.ok ? [] : v1.problems.map((x) => x.code)).toEqual(["layout"]);
    const none = await planImport({ incoming: tree({ "apps/a/app.yaml": "name: A\n" }), receiving: tree(RECEIVING), checks: fakeChecks().checks });
    expect(none.ok ? [] : none.problems.map((x) => x.message)).toEqual(["workspace.yaml 이 없습니다. Avocado 워크스페이스를 내보낸 zip 이나 폴더가 아닙니다"]);
  });

  it("받는 쪽 서브플로우와 대소문자만 다른 이름은 새 파일을 만들지 않고 받는 쪽 이름으로만 쓴다", async () => {
    const receiving = { ...RECEIVING, "apps/settings/flows/ios/common/Setup.yaml": SUB };
    const theirs = "appId: ${APP_ID}\n---\n- hideKeyboard\n";
    const p = await plan(
      {
        "apps/settings/flows/ios/common/setup.yaml": theirs,
        "apps/settings/testcases/TC-0005.md": tcMd("TC-0005", "settings", "준비"),
        "apps/settings/flows/ios/TC-0005.yaml": flow("TC-0005", ["- runFlow: common/setup.yaml", '- assertVisible: "x"']),
      },
      receiving,
    );
    const sub = item(p, "subflow:settings:ios:setup.yaml");
    expect(sub).toMatchObject({ status: "differs", defaultChoice: "keep-ours" });
    expect(sub.compare[0]?.path).toBe("apps/settings/flows/ios/common/Setup.yaml");
    // 가져온 뒤에는 Setup.yaml 만 있으므로 common/setup.yaml 을 부르는 플로우는 받지 않는다
    expect(item(p, "testcase:settings:TC-0005").note).toContain("없는 서브플로우다: common/setup.yaml");
    const w = p.apply([{ key: sub.key, action: "take-theirs" }]);
    expect([...w.files.keys()]).toEqual(["apps/settings/flows/ios/common/Setup.yaml"]);
  });

  it("형식이 틀린 app.yaml·accounts.yaml 은 받지 않고 그 앱의 테스트 케이스도 받지 않는다", async () => {
    const p = await plan({ ...NOTES, "apps/notes/app.yaml": "name: Notes\ntargets: {}\n", "apps/notes/accounts.yaml": "Admin:\n  description: x\n  keys: [lower]\n" });
    const app = item(p, "app:notes");
    expect(app.status).toBe("rejected");
    expect(app.note).toContain("apps/notes/app.yaml 형식 오류: targets: 타깃이 하나 이상 있어야 한다");
    expect(app.note).toContain("apps/notes/accounts.yaml 형식 오류");
    expect(item(p, "testcase:notes:TC-0002").status).toBe("rejected");
    const yamlError = await plan({ ...NOTES, "apps/notes/app.yaml": "name: [Notes\n" });
    expect(item(yamlError, "app:notes").note).toMatch(/^apps\/notes\/app\.yaml YAML 오류: \d+줄 /);
  });

  it("다른 앱 id 의 폴더가 받는 쪽에 workspace.yaml 없이 있으면 새 앱으로 받지 않는다", async () => {
    const p = await plan(NOTES, { ...RECEIVING, "apps/notes/testcases/TC-0100.md": tcMd("TC-0100", "notes", "남은 파일") });
    expect(item(p, "app:notes").note).toBe("workspace.yaml 의 앱 목록에 없는 apps/notes 폴더가 이 워크스페이스에 있습니다");
    expect(item(p, "testcase:notes:TC-0002").status).toBe("rejected");
  });
});
