import { accountSecretName, type SecretName, type SecretStatus, type WorkspaceAccounts } from "@qa/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { accountAppHint, accountApps } from "../lib/account-values";
import { errorMessage } from "../lib/errors";
import { SecretRow } from "./SecretRow";

const OTHERS = "__others__";

function accountLabel(name: string): string {
  const [, appId, key] = name.split(":");
  return `${appId} · ${key}`;
}

/**
 * 테스트 계정 값. 위는 요약 한 줄, 왼쪽은 앱 목록(앱마다 넣은 값 수)과 "그 밖의 값", 오른쪽은 고른 앱의 키들이다.
 * 앱 ID·키 이름은 워크스페이스의 apps/<앱>/accounts.yaml 에서 읽어 줄로 보이고, 사용자는 값만 넣는다.
 * 값은 main 의 키체인 암호화로만 저장하고 화면에는 저장 여부만 온다(CLAUDE.md 5·6장).
 * 워크스페이스에 없는 키는 "그 밖의 값"에서 직접 추가하거나 지운다.
 */
export function AccountValues(props: { secrets: SecretStatus[]; locked: boolean; onChanged: () => Promise<void>; onOpenWorkspace: () => void }) {
  const [accounts, setAccounts] = useState<WorkspaceAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 왼쪽에서 고른 앱(또는 그 밖의 값). 목록을 처음 읽었을 때 한 번 정한다(값을 넣는 동안 고른 것이 바뀌지 않게) */
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(() => {
    window.qa.workspace.accounts().then(setAccounts, (e: unknown) => setError(`워크스페이스의 계정 목록을 읽지 못했습니다: ${errorMessage(e)}`));
  }, []);
  useEffect(load, [load]);

  const stored = new Map(props.secrets.map((s) => [s.name, s]));
  const status = (name: string): SecretStatus => stored.get(name as SecretName) ?? { name: name as SecretName, stored: false, updatedAt: null };
  const apps = accounts ? accountApps(accounts, props.secrets) : [];
  const needed = new Set(apps.flatMap((a) => a.keys.map((k) => k.name)));
  const missing = apps.reduce((n, a) => n + a.keys.length - a.stored, 0);
  const others = props.secrets.filter((s) => s.name.startsWith("account:") && s.stored && !needed.has(s.name));
  const connected = accounts?.connected === true;

  // 넣지 않은 값이 있는 첫 앱을 연다. 연결 전이거나 앱이 없으면 그 밖의 값(직접 추가)
  const fallback = connected && apps.length > 0 ? (apps.find((a) => a.stored < a.keys.length) ?? apps[0])?.app ?? OTHERS : OTHERS;
  useEffect(() => {
    if (accounts !== null) setPicked((current) => current ?? fallback);
    // 처음 읽었을 때만 정한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);
  const selected = picked ?? fallback;
  const app = apps.find((a) => a.app === selected) ?? null;

  return (
    <div className="split-fill" data-testid="account-values">
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {connected && apps.length > 0 ? (
        <section className="card strip" aria-label="테스트 계정 요약">
          <span className={missing === 0 ? "dot on" : "dot waiting"} aria-hidden="true" />
          <div className="strip-text">
            <strong data-testid="account-values-summary">{missing === 0 ? "필요한 계정 값을 모두 넣었습니다." : `아직 넣지 않은 값 ${missing}개`}</strong>
            <span className="hint">값은 이 Mac 의 키체인에만 두고, 값이 없는 키를 쓰는 플로우는 실행을 시작하지 않습니다.</span>
          </div>
          <button type="button" className="secondary small" onClick={props.onOpenWorkspace}>
            역할·키 이름 바꾸기
          </button>
        </section>
      ) : null}

      <div className="split-panes">
        <nav className="card pane-nav" aria-label="앱">
          <strong className="group-label">앱</strong>
          {accounts === null && !error ? <p className="hint">불러오는 중</p> : null}
          {accounts && !connected ? <p className="hint">워크스페이스를 연결하면 앱마다 필요한 계정 값이 여기 나옵니다.</p> : null}
          {connected && apps.length === 0 ? <p className="hint">워크스페이스에 앱이 없습니다.</p> : null}
          {apps.map((a) => (
            <button key={a.app} type="button" className={a.app === selected ? "run-item selected" : "run-item"} aria-current={a.app === selected ? "page" : undefined} data-testid={`account-nav-${a.app}`} onClick={() => setPicked(a.app)}>
              <span className="run-item-body">
                <strong>
                  {a.name} <span className="ws-app-id">({a.app})</span>
                </strong>
                <small className="hint">{accountAppHint(a)}</small>
              </span>
              {a.keys.length > 0 ? <span className={a.stored === a.keys.length ? "dot on" : "dot waiting"} aria-hidden="true" /> : <span />}
            </button>
          ))}
          <span className="pane-nav-gap" />
          <button type="button" className={selected === OTHERS ? "run-item selected" : "run-item"} aria-current={selected === OTHERS ? "page" : undefined} data-testid="account-nav-others" onClick={() => setPicked(OTHERS)}>
            <span className="run-item-body">
              <strong>그 밖의 값</strong>
              <small className="hint">{others.length > 0 ? `워크스페이스에 없는 키 ${others.length}개` : "직접 추가"}</small>
            </span>
            <span />
          </button>
        </nav>

        {app ? (
          <section className="card pane" aria-label={`${app.name} 계정 값`} data-testid={`account-app-${app.app}`}>
            <div className="pane-head">
              <h2>
                {app.name} ({app.app})
              </h2>
              <small className="hint">apps/{app.app}/accounts.yaml 에 적힌 키입니다. 값만 넣습니다. 실제 사용자 계정이 아니라 테스트 계정 값만 씁니다. 플로우를 실행할 때만 앱이 꺼내 넘기고 결과에서 가립니다.</small>
            </div>
            <div className="pane-body">
              {app.keys.length === 0 ? <p className="hint">이 앱은 계정 값이 필요 없습니다.</p> : null}
              <ul className="key-rows">
                {app.keys.map((k) => (
                  <li key={k.name}>
                    <small className="hint">
                      {k.roles.join(", ")} 역할{k.descriptions.length ? ` · ${k.descriptions.join(" / ")}` : ""}
                    </small>
                    <SecretRow status={status(k.name)} label={k.key} disabled={props.locked} onChanged={props.onChanged} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : (
          <section className="card pane" aria-label="그 밖의 값">
            <div className="pane-head">
              <h2>그 밖의 값</h2>
              <small className="hint">워크스페이스의 accounts.yaml 에 없는 키의 값입니다.</small>
            </div>
            <div className="pane-body">
              {others.length > 0 ? (
                <>
                  <strong className="group-label">워크스페이스에 없는 계정 값</strong>
                  <p className="hint">지금 워크스페이스의 accounts.yaml 에 없는 키입니다. 더 쓰지 않으면 지웁니다.</p>
                  <ul className="key-rows" data-testid="account-values-others">
                    {others.map((s) => (
                      <li key={s.name}>
                        <SecretRow status={s} label={accountLabel(s.name)} disabled={props.locked} onChanged={props.onChanged} />
                      </li>
                    ))}
                  </ul>
                  <hr className="rule" />
                </>
              ) : null}
              <strong className="group-label">직접 추가</strong>
              <p className="hint">키 이름은 보통 워크스페이스 앱 설정에서 정합니다. 워크스페이스에 아직 없는 키의 값을 먼저 넣어 둘 때만 씁니다.</p>
              <AddAccountSecret disabled={props.locked} onAdded={props.onChanged} />
            </div>
          </section>
        )}
      </div>
    </div>
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
