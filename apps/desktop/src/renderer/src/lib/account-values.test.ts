import type { SecretStatus, WorkspaceAccounts } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { accountAppHint, accountApps, missingAccountValues } from "./account-values";

const accounts: WorkspaceAccounts = {
  connected: true,
  apps: [
    { app: "demo", name: "Demo", roles: [{ role: "signup", description: "가입용 비밀번호", keys: ["DEMO_TEST_PASSWORD"] }] },
    {
      app: "sample",
      name: "Sample",
      roles: [
        { role: "student", description: "학생 계정", keys: ["SAMPLE_ID", "SAMPLE_PW"] },
        { role: "teacher", description: "선생님 계정", keys: ["SAMPLE_ID"] },
      ],
    },
    { app: "notes", name: "Notes", roles: [] },
  ],
};
const stored = (...names: string[]): SecretStatus[] => names.map((name) => ({ name, stored: true, updatedAt: null }) as SecretStatus);

describe("테스트 계정 값", () => {
  it("앱마다 키를 한 번씩만 보이고(같은 키를 쓰는 역할은 함께), 값이 있는지 센다", () => {
    const apps = accountApps(accounts, stored("account:sample:SAMPLE_ID", "account:other:X"));
    expect(apps.map((a) => [a.app, a.stored, a.keys.map((k) => `${k.key}:${k.roles.join("+")}:${k.stored}`)])).toEqual([
      ["demo", 0, ["DEMO_TEST_PASSWORD:signup:false"]],
      ["sample", 1, ["SAMPLE_ID:student+teacher:true", "SAMPLE_PW:student:false"]],
      ["notes", 0, []],
    ]);
    expect(apps[1]?.keys[0]).toMatchObject({ name: "account:sample:SAMPLE_ID", descriptions: ["학생 계정", "선생님 계정"] });
    expect(apps.map(accountAppHint)).toEqual(["값 1개 중 0개 넣음", "값 2개 중 1개 넣음", "계정 값이 필요 없음"]);
    expect(accountApps(accounts, stored("account:demo:DEMO_TEST_PASSWORD")).map(accountAppHint)[0]).toBe("값 1개 모두 넣음");
  });

  it("아직 넣지 않은 값", () => {
    expect(missingAccountValues(accounts, stored("account:sample:SAMPLE_ID"))).toEqual(["account:demo:DEMO_TEST_PASSWORD", "account:sample:SAMPLE_PW"]);
  });
});
