import { accountSecretName, type SecretStatus, type WorkspaceAccounts } from "@qa/shared";

/** 워크스페이스 accounts.yaml 에 키가 있는데 이 Mac 에 값이 없는 계정 값 이름(account:<앱>:<KEY>) */
export function missingAccountValues(accounts: WorkspaceAccounts, secrets: readonly SecretStatus[]): string[] {
  const stored = new Set(secrets.filter((s) => s.stored).map((s) => s.name as string));
  const needed = new Set(accounts.apps.flatMap((a) => a.roles.flatMap((r) => r.keys.map((k) => accountSecretName(a.app, k)))));
  return [...needed].filter((name) => !stored.has(name)).sort();
}

export interface AccountKey {
  key: string;
  /** 비밀 이름: account:<앱>:<KEY> */
  name: string;
  /** 이 키를 쓰는 계정 역할 */
  roles: string[];
  descriptions: string[];
  stored: boolean;
}
export interface AccountApp {
  app: string;
  name: string;
  /** 키 하나는 한 번만(여러 역할이 같은 키를 쓰면 역할을 함께 적는다) */
  keys: AccountKey[];
  stored: number;
}

/** 워크스페이스의 앱마다 accounts.yaml 의 키와 이 Mac 에 값이 있는지 */
export function accountApps(accounts: WorkspaceAccounts, secrets: readonly SecretStatus[]): AccountApp[] {
  const stored = new Set(secrets.filter((s) => s.stored).map((s) => s.name as string));
  return accounts.apps.map((a) => {
    const keys = new Map<string, AccountKey>();
    for (const r of a.roles) {
      for (const key of r.keys) {
        const name = accountSecretName(a.app, key);
        const entry = keys.get(key) ?? { key, name, roles: [], descriptions: [], stored: stored.has(name) };
        entry.roles.push(r.role);
        if (r.description && !entry.descriptions.includes(r.description)) entry.descriptions.push(r.description);
        keys.set(key, entry);
      }
    }
    const list = [...keys.values()];
    return { app: a.app, name: a.name, keys: list, stored: list.filter((k) => k.stored).length };
  });
}

/** 앱 목록의 한 줄: "값 2개 중 1개 넣음" */
export function accountAppHint(app: AccountApp): string {
  if (app.keys.length === 0) return "계정 값이 필요 없음";
  return app.stored === app.keys.length ? `값 ${app.keys.length}개 모두 넣음` : `값 ${app.keys.length}개 중 ${app.stored}개 넣음`;
}
