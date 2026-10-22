import type { AgentUsage, RemoteVerify, SecretsList, Settings, SettingsState, UpdateStatus } from "@qa/shared";
import { AccountValues } from "../components/AccountValues";
import { ClaudeConnectionPanel } from "../components/ClaudeConnectionPanel";
import { GitHubRepoPicker } from "../components/GitHubRepoPicker";
import { SecretRow } from "../components/SecretRow";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/errors";

const APP_SECRET_LABELS: Record<string, string> = {
  anthropicApiKey: "Anthropic API 키",
  githubToken: "GitHub 토큰",
};


export function SettingsPage() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [secrets, setSecrets] = useState<SecretsList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextState, nextSecrets] = await Promise.all([window.qa.settings.get(), window.qa.secrets.list()]);
      setState(nextState);
      setSecrets(nextSecrets);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <p role="alert" className="error">
        설정을 불러오지 못했습니다: {error}
      </p>
    );
  }
  if (!state || !secrets) return <p>불러오는 중</p>;

  // Claude 앱 방식(D17)에서는 Anthropic API 키를 묻지 않는다. 이미 저장한 키는 지울 수 있게 보인다
  const viaClaude = state.settings.agent.provider === "claude-app";
  const appSecrets = secrets.items.filter((s) => !s.name.startsWith("account:") && !(viaClaude && s.name === "anthropicApiKey" && !s.stored));
  const accountSecrets = secrets.items.filter((s) => s.name.startsWith("account:"));
  const locked = !secrets.encryptionAvailable;

  return (
    <>
      <h1>설정</h1>
      {state.issue ? (
        <p role="alert" className="warning">
          {state.issue}
        </p>
      ) : null}
      {locked ? (
        <p role="alert" className="error">
          이 Mac에서 키체인 암호화를 쓸 수 없어 비밀을 저장할 수 없습니다. 평문으로 대신 저장하지 않습니다.
        </p>
      ) : null}

      <section className="card stack" aria-labelledby="secrets-title">
        <h2 id="secrets-title">API 키와 토큰</h2>
        <p className="hint">값은 macOS 키체인 키로 암호화해 이 Mac에만 저장합니다. 저장한 값은 다시 표시하지 않습니다.</p>
        {appSecrets.map((s) => (
          <SecretRow key={s.name} status={s} label={APP_SECRET_LABELS[s.name] ?? s.name} disabled={locked} onChanged={reload} />
        ))}
      </section>

      <AccountValues secrets={accountSecrets} locked={locked} onChanged={reload} />

      <section className="card stack" aria-labelledby="claude-title">
        <h2 id="claude-title">Claude 연결</h2>
        <ClaudeConnectionPanel
          key={state.settings.agent.provider}
          provider={state.settings.agent.provider}
          onSaved={reload}
          apiKeySlot={<p className="hint">API 키는 위 "API 키와 토큰"에 넣고, 월 비용 상한은 아래 "일반"에서 정합니다.</p>}
        />
      </section>
      <GeneralSection settings={state.settings} onSaved={reload} />
      <AgentUsageSection key={state.settings.agent.monthlyBudgetUsd} />
      <GitHubSection settings={state.settings} tokenStored={secrets.items.some((i) => i.name === "githubToken" && i.stored)} onSaved={reload} />
      <PolicySection
        key={String(state.settings.policy.evidenceUploadApproved)}
        settings={state.settings}
        onSaved={reload}
      />
      <VersionSection />
    </>
  );
}

function GeneralSection(props: { settings: Settings; onSaved: () => Promise<void> }) {
  const { settings } = props;
  const [retentionDays, setRetentionDays] = useState(String(settings.evidence.retentionDays));
  const [budget, setBudget] = useState(String(settings.agent.monthlyBudgetUsd));
  const [sampleRate, setSampleRate] = useState(String(settings.agent.judgeSampleRate));
  const [locale, setLocale] = useState(settings.devices.locale);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await window.qa.settings.update({
        evidence: { retentionDays: Number(retentionDays) },
        agent: { monthlyBudgetUsd: Number(budget), judgeSampleRate: Number(sampleRate) },
        devices: { locale },
      });
      setMessage("저장했습니다");
      await props.onSaved();
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  return (
    <form className="card stack" onSubmit={save} aria-labelledby="general-title">
      <h2 id="general-title">일반</h2>
      <div className="grid">
        <label>
          로컬 증적 보관 일수
          <input type="number" min={1} max={365} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
        </label>
        <label>
          월 LLM 비용 상한 (USD, API 키 방식)
          <input type="number" min={0} max={10000} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label>
          자동 화면 판정 비율 (0~1, API 키 방식)
          <input type="number" min={0} max={1} step="0.05" value={sampleRate} onChange={(e) => setSampleRate(e.target.value)} />
        </label>
        <label>
          QA 기기 언어
          <input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="ko_KR" />
        </label>
      </div>
      <div className="row">
        <button type="submit">저장</button>
        {message ? (
          <small role="status" className="hint">
            {message}
          </small>
        ) : null}
      </div>
    </form>
  );
}

const JOB_TYPE_LABELS: Record<string, string> = { author: "플로우 만들기", heal: "실패 분석", judge: "화면 판정", explore: "탐색" };

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** 이번 달 LLM 사용량(PLAN 6.4). 상한은 일반 설정에서 바꾼다 */
function AgentUsageSection() {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.qa.agent.usage().then(setUsage, (e: unknown) => setError(errorMessage(e)));
  }, []);

  return (
    <section className="card stack" aria-labelledby="agent-usage-title">
      <h2 id="agent-usage-title">LLM 사용량</h2>
      {error ? (
        <p role="alert" className="error">
          사용량을 불러오지 못했습니다: {error}
        </p>
      ) : null}
      {usage ? (
        <div className="stack" data-testid="agent-usage">
          <p>
            {usage.month} 비용 <strong>{usd(usage.costUsd)}</strong> / 상한 {usd(usage.monthlyBudgetUsd)} · 작업 {usage.jobs}건
          </p>
          {usage.costUsd >= usage.monthlyBudgetUsd ? (
            <p role="alert" className="warning">
              이번 달 상한에 닿아 새 에이전트 작업을 시작하지 않습니다.
            </p>
          ) : null}
          {usage.byType.length > 0 ? (
            <p className="hint">{usage.byType.map((t) => `${JOB_TYPE_LABELS[t.type] ?? t.type} ${t.jobs}건 ${usd(t.costUsd)}`).join(" · ")}</p>
          ) : (
            <p className="hint">이번 달 에이전트 작업이 없습니다.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** 앱 버전과 새 버전 확인(PLAN 11장). 받기는 새 버전 배너에서 한다 */
function VersionSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    window.qa.update.status().then(setStatus, () => undefined);
  }, []);

  async function check() {
    setChecking(true);
    try {
      setStatus(await window.qa.update.check());
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="card stack" aria-label="버전" data-testid="version-section">
      <h2>버전</h2>
      <div className="row">
        <span>
          Avocado <strong data-testid="settings-version">{status?.current ?? "확인 중"}</strong>
          {status?.latest ? ` · 최신 릴리스 ${status.latest}` : ""}
          {status?.available ? " · 새 버전이 있습니다(위 배너에서 받기)" : ""}
        </span>
        <button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
          {checking ? "확인 중" : "새 버전 확인"}
        </button>
      </div>
      {status?.checkedAt ? <small className="hint">마지막 확인 {new Date(status.checkedAt).toLocaleString("ko-KR")}</small> : null}
      {status?.error ? <small className="warning">{status.error}</small> : null}
    </section>
  );
}

function PolicySection(props: { settings: Settings; onSaved: () => Promise<void> }) {
  // 클릭 즉시 반영하고, 저장에 실패하면 되돌린다.
  const [approved, setApproved] = useState(props.settings.policy.evidenceUploadApproved);
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setApproved(next);
    try {
      await window.qa.settings.update({ policy: { evidenceUploadApproved: next } });
      setMessage(null);
      await props.onSaved();
    } catch (e) {
      setApproved(!next);
      setMessage(errorMessage(e));
    }
  }

  return (
    <section className="card stack" aria-labelledby="policy-title">
      <h2 id="policy-title">조직 정책</h2>
      <label className="check">
        <input type="checkbox" checked={approved} onChange={(e) => void toggle(e.target.checked)} />
        외부 GitHub 증적 업로드가 조직 보안 정책으로 승인됨 (D11)
      </label>
      <p className="hint">
        꺼져 있으면 증적 업로드 기능을 숨깁니다. 운영자가 보안 담당 확인 후에만 켭니다.
      </p>
      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function GitHubSection(props: { settings: Settings; tokenStored: boolean; onSaved: () => Promise<void> }) {
  const g = props.settings.github;
  const [owner, setOwner] = useState(g.owner ?? "");
  const [workspaceRepo, setWorkspaceRepo] = useState(g.workspaceRepo);
  const [prefix, setPrefix] = useState(g.evidenceRepoPrefix);
  const [appRepo, setAppRepo] = useState(g.appRepo);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RemoteVerify | null>(null);
  const [checking, setChecking] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await window.qa.settings.update({ github: { owner: owner.trim() || null, workspaceRepo: workspaceRepo.trim(), evidenceRepoPrefix: prefix.trim(), appRepo: appRepo.trim() } });
      setMessage("저장했습니다");
      await props.onSaved();
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  async function verify() {
    setChecking(true);
    setResult(null);
    setMessage(null);
    try {
      setResult(await window.qa.remote.verify());
    } catch (e) {
      setMessage(`연결하지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save} aria-labelledby="github-title">
      <h2 id="github-title">GitHub</h2>
      <p className="hint">
        TC·플로우는 워크스페이스 저장소, 증적 요약은 연도별 증적 저장소에 둡니다. 토큰은 위의 &quot;GitHub 토큰&quot;에 저장하고, git 에는 URL·설정 파일 대신 인증 도우미로만
        넘깁니다.
      </p>
      <GitHubRepoPicker
        github={g}
        tokenStored={props.tokenStored}
        onSaved={(next) => {
          // 아래 직접 입력 칸도 고른 값으로 맞춘다
          setOwner(next.owner ?? "");
          setWorkspaceRepo(next.workspaceRepo);
          setPrefix(next.evidenceRepoPrefix);
          setAppRepo(next.appRepo);
          return props.onSaved();
        }}
      />
      <p className="hint">목록에 없으면 아래에 직접 입력합니다.</p>
      <div className="grid">
        <label>
          GitHub 조직
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="GitHub 사용자 또는 조직 이름" />
        </label>
        <label>
          워크스페이스 저장소
          <input value={workspaceRepo} onChange={(e) => setWorkspaceRepo(e.target.value)} />
        </label>
        <label>
          증적 저장소 접두사
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </label>
        <label>
          앱 저장소(새 버전 확인)
          <input value={appRepo} onChange={(e) => setAppRepo(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button type="submit">저장</button>
        <button type="button" className="secondary" disabled={checking || !props.tokenStored || !g.owner} onClick={() => void verify()}>
          {checking ? "확인 중" : "연결 확인"}
        </button>
        {!props.tokenStored ? <small className="hint">GitHub 토큰을 먼저 저장합니다.</small> : null}
        {props.tokenStored && !g.owner ? <small className="hint">조직 이름을 저장하면 확인할 수 있습니다.</small> : null}
        {message ? (
          <small role="status" className="hint">
            {message}
          </small>
        ) : null}
      </div>
      {result ? (
        <ul className="checks" data-testid="github-verify">
          <li className="check">
            <span className="badge ok">로그인</span>
            <div className="check-body">
              <strong>{result.login}</strong>
            </div>
          </li>
          {result.repos.map((r) => (
            <li key={`${r.owner}/${r.repo}`} className="check">
              <span className={r.exists && r.canPush ? "badge ok" : "badge bad"}>{!r.exists ? "없음" : r.canPush ? "쓰기 가능" : "읽기만"}</span>
              <div className="check-body">
                <strong>
                  {r.owner}/{r.repo}
                </strong>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
