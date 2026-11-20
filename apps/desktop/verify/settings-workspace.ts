import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 실제 확인 여정(T-120·T-121)이 같이 쓰는 준비: 새 앱 데이터의 로컬 워크스페이스에 설정 앱 TC 둘(통과·실패)을 넣는다
export const REPO = join(__dirname, "../../..");
export const TOOLS = process.env["QA_VERIFY_TOOLS"] || join(REPO, "out/e2e/real-run-userdata/tools");
const FLOWS = join(REPO, "packages/evidence/fixtures/flows");
export const FAKE_ID = "qa-fixture-id-7f3a";

const testcase = (id: string, title: string) => `---
id: ${id}
title: ${title}
app: settings
targets: [ios]
priority: high
tags: [smoke]
account: fixture
status: active
---
## 스텝
1. 설정 앱 검색창에 테스트 값을 입력한다
   - 기대: 입력한 값이 검색창에 보인다
`;
// 픽스처 플로우의 앱 id 를 ${APP_ID} 로 바꾼다(실행은 app.yaml 의 앱 id 를 넣는다)
const flow = (name: string) => readFileSync(join(FLOWS, name), "utf8").replace("appId: com.apple.Preferences", "appId: ${APP_ID}");

export function seedSettingsWorkspace(userDataDir: string) {
  const dir = join(userDataDir, "local-workspace");
  const files: Record<string, string> = {
    "workspace.yaml": "schemaVersion: 2\nname: verify\napps: [settings]\ndefaults:\n  locale: ko_KR\n",
    "apps/settings/app.yaml": "name: Settings\nlocale: ko_KR\ntargets:\n  ios:\n    appId: com.apple.Preferences\n",
    "apps/settings/accounts.yaml": "fixture:\n  description: 픽스처 계정 값\n  keys: [QA_FIXTURE_ACCOUNT_ID]\n",
    "apps/settings/testcases/TC-0001.md": testcase("TC-0001", "설정 검색창에 값을 입력한다"),
    "apps/settings/testcases/TC-0002.md": testcase("TC-0002", "없는 결과를 누르면 실패한다"),
    "apps/settings/flows/ios/TC-0001.yaml": flow("ios-pass.yaml"),
    "apps/settings/flows/ios/TC-0002.yaml": flow("ios-fail.yaml"),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=verify", "-c", "user.email=verify@avocado.local", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "seed");
}

export const bootedSims = () =>
  Object.values((JSON.parse(execFileSync("/usr/bin/xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf8" })) as { devices: Record<string, { udid: string }[]> }).devices)
    .flat()
    .map((d) => d.udid);
