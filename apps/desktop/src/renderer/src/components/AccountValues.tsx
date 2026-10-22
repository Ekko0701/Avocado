import { accountSecretName, type SecretName, type SecretStatus, type WorkspaceAccounts } from "@qa/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/errors";
import { SecretRow } from "./SecretRow";

function accountLabel(name: string): string {
  const [, appId, key] = name.split(":");
  return `${appId} · ${key}`;
}

/**
 * 테스트 계정 값. 앱 ID·키 이름은 워크스페이스의 apps/<앱>/accounts.yaml 에서 읽어 줄로 보이고, 사용자는 값만 넣는다.
 * 값은 main 의 키체인 암호화로만 저장하고 화면에는 저장 여부만 온다(CLAUDE.md 5·6장).
 * 워크스페이스에 없는 키는 직접 추가할 수 있고, 워크스페이스에서 빠진 키의 값은 따로 보여 지울 수 있게 한다.
 */
export function AccountValues(props: { secrets: SecretStatus[]; locked: boolean; onChanged: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<WorkspaceAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.qa.workspace.accounts().then(setAccounts, (e: unknown) => setError(`워크스페이스의 계정 목록을 읽지 못했습니다: ${errorMessage(e)}`));
  }, []);
  useEffect(load, [load]);

  const stored = new Map(props.secrets.map((s) => [s.name, s]));
  const status = (name: string): SecretStatus => stored.get(name as SecretName) ?? { name: name as SecretName, stored: false, updatedAt: null };
  // 앱마다 키 하나는 한 번만 보인다(여러 역할이 같은 키를 쓰면 역할을 함께 적는다)
  const apps = (accounts?.apps ?? []).map((a) => {
    const keys = new Map<string, { roles: string[]; descriptions: string[] }>();
    for (const r of a.roles) {
      for (const key of r.keys) {
        const entry = keys.get(key) ?? { roles: [], descriptions: [] };
        entry.roles.push(r.role);
        if (r.description) entry.descriptions.push(r.description);
        keys.set(key, entry);
      }
    }
    return { ...a, keys: [...keys.entries()].map(([key, info]) => ({ key, name: accountSecretName(a.app, key), ...info })) };
  });
  const needed = new Set(apps.flatMap((a) => a.keys.map((k) => k.name)));
  const missing = apps.flatMap((a) => a.keys).filter((k) => !status(k.name).stored).length;
  const others = props.secrets.filter((s) => s.name.startsWith("account:") && s.stored && !needed.has(s.name));

  return (
    <section className="card stack" aria-labelledby="accounts-title" data-testid="account-values">
      <h2 id="accounts-title">테스트 계정 값</h2>
      <p className="hint">
        워크스페이스의 앱마다 accounts.yaml 에 적힌 키 이름입니다. 값만 넣습니다. 값은 이 Mac 의 키체인에만 두고, 플로우를 실행할 때만 앱이 꺼내 넘긴 뒤 결과에서 가립니다. 실제
        사용자 계정이 아니라 테스트 계정 값만 씁니다.
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {accounts && !accounts.connected ? <p className="hint">워크스페이스를 연결하면 앱마다 필요한 계정 값이 여기 나옵니다.</p> : null}
      {accounts?.connected && apps.length === 0 ? <p className="hint">워크스페이스에 앱이 없습니다.</p> : null}
      {accounts?.connected && apps.length > 0 ? (
        <p className="hint" data-testid="account-values-summary">
          {missing === 0 ? "필요한 계정 값을 모두 넣었습니다." : `아직 넣지 않은 값 ${missing}개`}
        </p>
      ) : null}
      {apps.map((a) => (
        <div key={a.app} className="stack" data-testid={`account-app-${a.app}`}>
          <h3>
            {a.name} <span className="hint">({a.app})</span>
          </h3>
          {a.keys.length === 0 ? <p className="hint">이 앱은 계정 값이 필요 없습니다.</p> : null}
          {a.keys.map((k) => (
            <div key={k.name} className="stack">
              <small className="hint">
                {k.roles.join(", ")} 역할{k.descriptions.length ? ` · ${k.descriptions.join(" / ")}` : ""}
              </small>
              <SecretRow status={status(k.name)} label={accountLabel(k.name)} disabled={props.locked} onChanged={props.onChanged} />
            </div>
          ))}
        </div>
      ))}
      {others.length > 0 ? (
        <div className="stack" data-testid="account-values-others">
          <h3>워크스페이스에 없는 계정 값</h3>
          <p className="hint">지금 워크스페이스의 accounts.yaml 에 없는 키입니다. 더 쓰지 않으면 지웁니다.</p>
          {others.map((s) => (
            <SecretRow key={s.name} status={s} label={accountLabel(s.name)} disabled={props.locked} onChanged={props.onChanged} />
          ))}
        </div>
      ) : null}
      <details open={accounts !== null && !accounts.connected}>
        <summary>직접 추가(워크스페이스에 없는 키)</summary>
        <AddAccountSecret disabled={props.locked} onAdded={props.onChanged} />
      </details>
    </section>
  );
}

function AddAccountSecret(props: { disabled: boolean; onAdded: () => Promise<void> }) {
  const [appId, setAppId] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    const name = accountSecretName(appId.trim(), key.trim()) as SecretName;
    try {
      await window.qa.secrets.set({ name, value: value.trim() });
      setValue("");
      setMessage("저장했습니다");
      await props.onAdded();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  return (
    <form className="row" onSubmit={add} aria-label="테스트 계정 값 추가">
      <label>
        앱 ID
        <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="apps/ 아래 폴더 이름" disabled={props.disabled} />
      </label>
      <label>
        키 이름
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="대문자·숫자·밑줄" disabled={props.disabled} />
      </label>
      <label className="grow">
        값
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} disabled={props.disabled} />
      </label>
      <button type="submit" disabled={props.disabled || !appId.trim() || !key.trim() || !value.trim()}>
        추가
      </button>
      {message ? (
        <small role="status" className="hint">
          {message}
        </small>
      ) : null}
    </form>
  );
}
