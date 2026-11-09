import { accountSecretName, type SecretStatus, type WorkspaceAccounts } from "@qa/shared";

/** 워크스페이스 accounts.yaml 에 키가 있는데 이 Mac 에 값이 없는 계정 값 이름(account:<앱>:<KEY>) */
export function missingAccountValues(accounts: WorkspaceAccounts, secrets: readonly SecretStatus[]): string[] {
  const stored = new Set(secrets.filter((s) => s.stored).map((s) => s.name as string));
  const needed = new Set(accounts.apps.flatMap((a) => a.roles.flatMap((r) => r.keys.map((k) => accountSecretName(a.app, k)))));
  return [...needed].filter((name) => !stored.has(name)).sort();
}
