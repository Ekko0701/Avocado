import {
  evidenceChoice,
  evidenceRepoOf,
  type AgentUsage,
  type AppInfo,
  type ClaudeConnection,
  type DbStatus,
  type IosSigningTeam,
  type RemoteVerify,
  type SecretStatus,
  type SecretsList,
  type Settings,
  type SettingsState,
  type UpdateStatus,
} from "@qa/shared";
import { ClaudeConnectionPanel } from "../components/ClaudeConnectionPanel";
import { GitHubRepoPicker } from "../components/GitHubRepoPicker";
import { SecretRow } from "../components/SecretRow";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";
import { sectionSummaries, SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settings-sections";
import { notifyUpdateStatus, onUpdateStatus } from "../lib/update-events";

/**
 * 설정: 왼쪽은 구역 목록(구역마다 지금 상태 한 줄), 오른쪽은 고른 구역 하나.
 * 구역은 하는 일에 따라 묶는다: GitHub(토큰·저장소·연결 확인), Claude(방식·연결, API 키 방식이면 키·상한·사용량),
 * 증적(로컬 보관·업로드 정책), 기기(언어·iPhone 러너 서명 팀), 앱 정보(버전·진단)
 */
export function SettingsPage() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [secrets, setSecrets] = useState<SecretsList | null>(null);
  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [section, setSection] = useState<SettingsSectionId>("github");
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
    // 구역 목록의 상태 줄과 사용량. 못 읽어도 설정은 쓸 수 있다
    window.qa.claude.status().then(setClaude, () => setClaude(null));
    window.qa.agent.usage().then(
      (u) => {
        setUsage(u);
        setUsageError(null);
      },
      (e: unknown) => setUsageError(errorMessage(e)),
    );
  }, []);

  useEffect(() => {
    void reload();
    window.qa.update.status().then(setUpdate, () => undefined);
    // 배너에서 받기를 하면 이 화면도 맞춘다
    return onUpdateStatus(setUpdate);
  }, [reload]);

  if (error) {
    return (
      <p role="alert" className="error">
        설정을 불러오지 못했습니다: {error}
      </p>
    );
  }
  if (!state || !secrets) return <p>불러오는 중</p>;

  const { settings } = state;
  const locked = !secrets.encryptionAvailable;
  const summaries = sectionSummaries({ settings, secrets, claude, usage, update });
  const secret = (name: string): SecretStatus => secrets.items.find((i) => i.name === name) ?? { name, stored: false, updatedAt: null };

  return (
    <div className="settings-page">
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

      <div className="settings-panes">
        <nav className="card settings-nav" aria-label="설정 구역">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === section ? "run-item selected" : "run-item"}
              aria-current={s.id === section ? "page" : undefined}
              data-testid={`settings-nav-${s.id}`}
              onClick={() => setSection(s.id)}
            >
              <span className="run-item-body">
                <strong>{s.label}</strong>
                <small className="hint">{summaries[s.id].hint}</small>
              </span>
              {summaries[s.id].dot ? <span className={`dot ${summaries[s.id].dot}`} aria-hidden="true" /> : <span />}
            </button>
          ))}
        </nav>

        {section === "github" ? <GitHubSection settings={settings} token={secret("githubToken")} locked={locked} onSaved={reload} /> : null}
        {section === "claude" ? (
          <ClaudeSection key={`${settings.agent.provider}:${settings.agent.monthlyBudgetUsd}`} settings={settings} apiKey={secret("anthropicApiKey")} locked={locked} usage={usage} usageError={usageError} onSaved={reload} />
        ) : null}
        {section === "evidence" ? <EvidenceSection key={String(settings.policy.evidenceUploadApproved)} settings={settings} onSaved={reload} onOpenGitHub={() => setSection("github")} /> : null}
        {section === "devices" ? <DevicesSection settings={settings} onSaved={reload} /> : null}
        {section === "app" ? <AppSection status={update} onStatus={setUpdate} /> : null}
      </div>
    </div>
  );
}

function SectionHead(props: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="settings-head">
      <h2 id={props.id}>{props.title}</h2>
      <small className="hint">{props.children}</small>
    </div>
  );
}

function GitHubSection(props: { settings: Settings; token: SecretStatus; locked: boolean; onSaved: () => Promise<void> }) {
  const g = props.settings.github;
  const tokenStored = props.token.stored;
  const [owner, setOwner] = useState(g.owner ?? "");
  const [workspaceRepo, setWorkspaceRepo] = useState(g.workspaceRepo);
  const year = new Date().getFullYear();
  /** 증적 저장소 이름. 연도로 끝나면 연도별(접두사만 저장), 아니면 이름 그대로 쓴다(ADR 0033) */
  const evidenceName = (s: Settings["github"]) => s.evidenceRepo ?? `${s.evidenceRepoPrefix}${year}`;
  const [evidence, setEvidence] = useState(evidenceName(g));
  const [evidenceOwner, setEvidenceOwner] = useState(g.evidenceOwner ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RemoteVerify | null>(null);
  const [checking, setChecking] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      const ownerName = owner.trim() || null;
      const other = evidenceOwner.trim();
      await window.qa.settings.update({
        github: { owner: ownerName, workspaceRepo: workspaceRepo.trim(), ...evidenceChoice(evidence.trim(), g.evidenceRepoPrefix), evidenceOwner: other && other !== ownerName ? other : null },
      });
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
    <section className="card settings-detail" aria-labelledby="github-title">
      <SectionHead id="github-title" title="GitHub">
        테스트 케이스·플로우·증적 요약을 두는 저장소와 그 토큰입니다.
      </SectionHead>
      <div className="settings-body">
        <strong className="group-label">토큰</strong>
        <SecretRow status={props.token} label="GitHub 토큰" disabled={props.locked} onChanged={props.onSaved} />
        <p className="hint">값은 macOS 키체인 키로 암호화해 이 Mac 에만 저장하고 다시 표시하지 않습니다. git 에는 URL·설정 파일 대신 인증 도우미로만 넘깁니다.</p>
        <p className="hint">플로우가 쓰는 테스트 계정 값은 사이드바 검증 → 테스트 계정에서 넣습니다.</p>

        <hr className="rule" />
        {/* 저장 버튼은 아래 붙박이 줄에 있다(form 속성으로 이 양식에 묶는다). 토큰 줄이 따로 양식이라 겹쳐 둘 수 없다 */}
        <form id="github-form" className="stack" aria-label="GitHub 저장소" onSubmit={save}>
          <strong className="group-label">저장소</strong>
          <GitHubRepoPicker
            github={g}
            tokenStored={tokenStored}
            onSaved={(next) => {
              // 아래 직접 입력 칸도 고른 값으로 맞춘다
              setOwner(next.owner ?? "");
              setWorkspaceRepo(next.workspaceRepo);
              setEvidence(evidenceName(next));
              setEvidenceOwner(next.evidenceOwner ?? "");
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
              증적 저장소
              <input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            </label>
            <label>
              증적 저장소 주인(워크스페이스와 다를 때만)
              <input value={evidenceOwner} onChange={(e) => setEvidenceOwner(e.target.value)} placeholder="비우면 GitHub 조직과 같음" />
            </label>
          </div>
          <p className="hint">
            테스트 케이스·플로우는 워크스페이스 저장소에, 증적 요약은 증적 저장소에 둡니다. 증적 저장소 이름이 연도로 끝나면(예: …-{year}) 해마다 다음 연도 저장소로 넘어가고, 아니면 그 저장소 하나에 계속
            올립니다.
          </p>
        </form>

        {result ? (
          <>
            <hr className="rule" />
            <strong className="group-label">연결 확인 결과</strong>
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
          </>
        ) : null}
      </div>
      <div className="settings-foot" data-testid="settings-foot">
        <button type="submit" form="github-form">
          저장
        </button>
        <button type="button" className="secondary" disabled={checking || !tokenStored || !g.owner} onClick={() => void verify()}>
          {checking ? "확인 중" : "연결 확인"}
        </button>
        {!tokenStored ? <small className="hint">GitHub 토큰을 먼저 저장합니다.</small> : null}
        {tokenStored && !g.owner ? <small className="hint">조직 이름을 저장하면 확인할 수 있습니다.</small> : null}
        {message ? (
          <small role="status" className="hint">
            {message}
          </small>
        ) : null}
      </div>
    </section>
  );
}

const JOB_TYPE_LABELS: Record<string, string> = { author: "플로우 만들기", heal: "실패 분석", judge: "화면 판정", explore: "탐색" };
const usd = (value: number) => `$${value.toFixed(2)}`;

function ClaudeSection(props: { settings: Settings; apiKey: SecretStatus; locked: boolean; usage: AgentUsage | null; usageError: string | null; onSaved: () => Promise<void> }) {
  const { agent } = props.settings;
  const api = agent.provider === "api";
  const [budget, setBudget] = useState(String(agent.monthlyBudgetUsd));
  const [sampleRate, setSampleRate] = useState(String(agent.judgeSampleRate));
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await window.qa.settings.update({ agent: { monthlyBudgetUsd: Number(budget), judgeSampleRate: Number(sampleRate) } });
      setMessage("저장했습니다");
      await props.onSaved();
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  return (
    <section className="card settings-detail" aria-labelledby="claude-title">
      <SectionHead id="claude-title" title="Claude">
        플로우 만들기와 화면 판정을 누가 하는지 정합니다.
      </SectionHead>
      <div className="settings-body">
        <ClaudeConnectionPanel provider={agent.provider} onSaved={props.onSaved} />

        {/* Claude 앱 방식(D17)에서는 Anthropic API 키를 묻지 않는다. 이미 저장한 키는 지울 수 있게 보인다 */}
        {api || props.apiKey.stored ? (
          <>
            <hr className="rule" />
            <strong className="group-label">{api ? "API 키" : "저장된 API 키(지금 방식에서는 쓰지 않습니다)"}</strong>
            <SecretRow status={props.apiKey} label="Anthropic API 키" disabled={props.locked} onChanged={props.onSaved} />
            <p className="hint">값은 macOS 키체인 키로 암호화해 이 Mac 에만 저장하고 다시 표시하지 않습니다. 플로우가 쓰는 테스트 계정 값은 사이드바 검증 → 테스트 계정에서 넣습니다.</p>
          </>
        ) : null}

        {api ? (
          <>
            <hr className="rule" />
            <form id="claude-cost-form" className="stack" aria-label="비용" onSubmit={save}>
              <strong className="group-label">비용</strong>
              <div className="grid">
                <label>
                  월 LLM 비용 상한 (USD)
                  <input type="number" min={0} max={10000} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
                </label>
                <label>
                  자동 화면 판정 비율 (0~1)
                  <input type="number" min={0} max={1} step="0.05" value={sampleRate} onChange={(e) => setSampleRate(e.target.value)} />
                </label>
              </div>
              <p className="hint">작업 하나의 상한은 $5 입니다. 자동 화면 판정 비율이 0 이면 결과 화면에서 누를 때만 판정합니다.</p>
            </form>

            <hr className="rule" />
            <strong className="group-label">이번 달 사용량</strong>
            {props.usageError ? (
              <p role="alert" className="error">
                사용량을 불러오지 못했습니다: {props.usageError}
              </p>
            ) : null}
            {props.usage ? <Usage usage={props.usage} /> : null}
          </>
        ) : null}
      </div>
      {api ? (
        <div className="settings-foot" data-testid="settings-foot">
          <button type="submit" form="claude-cost-form">
            저장
          </button>
          {message ? (
            <small role="status" className="hint">
              {message}
            </small>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 이번 달 LLM 사용량(PLAN 6.4) */
function Usage(props: { usage: AgentUsage }) {
  const { usage } = props;
  const ratio = usage.monthlyBudgetUsd > 0 ? Math.min(1, usage.costUsd / usage.monthlyBudgetUsd) : 1;
  return (
    <div className="stack" data-testid="agent-usage">
      <p>
        {usage.month} 비용 <strong>{usd(usage.costUsd)}</strong> / 상한 {usd(usage.monthlyBudgetUsd)} · 작업 {usage.jobs}건
      </p>
      <div className="meter" role="progressbar" aria-label="이번 달 비용" aria-valuemin={0} aria-valuemax={usage.monthlyBudgetUsd} aria-valuenow={Math.min(usage.costUsd, usage.monthlyBudgetUsd)}>
        <div style={{ width: `${ratio * 100}%` }} />
      </div>
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
  );
}

function EvidenceSection(props: { settings: Settings; onSaved: () => Promise<void>; onOpenGitHub: () => void }) {
  const { settings } = props;
  const [retentionDays, setRetentionDays] = useState(String(settings.evidence.retentionDays));
  // 클릭 즉시 반영하고, 저장에 실패하면 되돌린다
  const [approved, setApproved] = useState(settings.policy.evidenceUploadApproved);
  const [message, setMessage] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const target = evidenceRepoOf(settings.github, new Date().getFullYear());

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await window.qa.settings.update({ evidence: { retentionDays: Number(retentionDays) } });
      setMessage("저장했습니다");
      await props.onSaved();
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  async function toggle(next: boolean) {
    setApproved(next);
    try {
      await window.qa.settings.update({ policy: { evidenceUploadApproved: next } });
      setPolicyError(null);
      await props.onSaved();
    } catch (e) {
      setApproved(!next);
      setPolicyError(errorMessage(e));
    }
  }

  return (
    <form className="card settings-detail" onSubmit={save} aria-labelledby="evidence-title">
      <SectionHead id="evidence-title" title="증적">
        캡처·로그를 이 Mac 에 얼마나 두고, 요약을 GitHub 에 올릴지 정합니다.
      </SectionHead>
      <div className="settings-body">
        <strong className="group-label">이 Mac 에 보관</strong>
        <label className="narrow">
          로컬 증적 보관 일수
          <input type="number" min={1} max={365} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
        </label>
        <p className="hint">보관 기간이 지나면 이 Mac 의 캡처·로그를 지웁니다. 실행 기록은 남고, 결과 화면에서 "보관"을 켠 실행은 지우지 않습니다.</p>

        <hr className="rule" />
        <strong className="group-label">GitHub 에 올리기</strong>
        <label className="check">
          <input type="checkbox" checked={approved} onChange={(e) => void toggle(e.target.checked)} />
          외부 GitHub 증적 업로드가 조직 보안 정책으로 승인됨 (D11)
        </label>
        <p className="hint">
          꺼져 있으면 결과 화면에 "증적 올리기" 탭이 나오지 않습니다. 운영자가 보안 담당 확인 후에만 켭니다. 올리는 것은 비밀 값을 가린 요약 묶음이고, 원본과 영상은 올리지 않습니다.
        </p>
        {policyError ? (
          <p role="alert" className="error">
            {policyError}
          </p>
        ) : null}
        <div className="row center" data-testid="evidence-target">
          <span>
            올라가는 곳: <strong>{target ? `${target.owner}/${target.repo}` : "GitHub 조직을 정하면 보입니다"}</strong>
          </span>
          <button type="button" className="secondary small" onClick={props.onOpenGitHub}>
            GitHub 에서 바꾸기
          </button>
        </div>
      </div>
      <div className="settings-foot" data-testid="settings-foot">
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

function DevicesSection(props: { settings: Settings; onSaved: () => Promise<void> }) {
  const [locale, setLocale] = useState(props.settings.devices.locale);
  const [team, setTeam] = useState(props.settings.devices.iosSigningTeam ?? "");
  const [teams, setTeams] = useState<IosSigningTeam[] | null>(null);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const findTeams = useCallback(async () => {
    setTeamsError(null);
    try {
      setTeams(await window.qa.devices.iosSigningTeams());
    } catch (e) {
      setTeamsError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void findTeams();
  }, [findTeams]);

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await window.qa.settings.update({ devices: { locale, iosSigningTeam: team || null } });
      setMessage("저장했습니다");
      await props.onSaved();
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  // 저장한 팀이 키체인에 없어도 고른 값은 그대로 보인다
  const options = teams ?? [];
  const missing = team && teams && !teams.some((t) => t.id === team);
  return (
    <form className="card settings-detail" onSubmit={save} aria-labelledby="devices-title">
      <SectionHead id="devices-title" title="기기">
        QA 기기의 언어와 iPhone 실기기 러너 서명을 정합니다.
      </SectionHead>
      <div className="settings-body">
        <strong className="group-label">언어</strong>
        <label className="narrow">
          QA 기기 언어
          <input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="ko_KR" />
        </label>
        <p className="hint">시뮬레이터·에뮬레이터를 준비할 때 이 언어로 맞춥니다. 예: ko_KR, en_US. 사람의 폰(Android 폰·iPhone)은 바꾸지 않습니다.</p>
        <hr className="rule" />
        <strong className="group-label">iPhone 실기기</strong>
        <label className="narrow">
          러너 서명 팀
          <select aria-label="러너 서명 팀" value={team} onChange={(e) => setTeam(e.target.value)} data-testid="ios-signing-team">
            <option value="">고르지 않음</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.id})
              </option>
            ))}
            {missing ? <option value={team}>{team} (이 Mac 에 인증서 없음)</option> : null}
          </select>
        </label>
        <p className="hint">
          이 Mac 키체인의 Apple Development 인증서에서 찾은 팀입니다. 처음 준비할 때 이 팀으로 러너({team ? `dev.avocado.agentdevice.${team.toLowerCase()}.runner` : "dev.avocado.agentdevice.<팀>.runner"})를 서명해 iPhone 에 올립니다. 무료 개인 팀도 됩니다.
        </p>
        {teams && teams.length === 0 ? <p className="hint">Apple Development 인증서가 없습니다. Xcode → 설정 → 계정에서 Apple 계정을 넣고 인증서를 만듭니다.</p> : null}
        {teamsError ? <p className="hint">팀을 찾지 못했습니다: {teamsError}</p> : null}
        <p className="hint">조직 팀을 고르면 그 팀 계정에 러너 App ID 와 개발용 프로파일이 생길 수 있습니다. 개인 팀을 권합니다.</p>
        <div className="row">
          <button type="button" className="secondary" onClick={() => void findTeams()}>
            팀 다시 찾기
          </button>
        </div>
      </div>
      <div className="settings-foot" data-testid="settings-foot">
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

/** 앱 버전·새 버전 확인(PLAN 11장. 받기는 새 버전 배너에서 한다)과 진단(IPC 확인). 문제를 알릴 때 함께 보낸다 */
function AppSection(props: { status: UpdateStatus | null; onStatus: (status: UpdateStatus) => void }) {
  const { status } = props;
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [db, setDb] = useState<DbStatus | null>(null);
  const [message, setMessage] = useState("hello");
  const [pong, setPong] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.qa.app.getInfo().then(setInfo, (e: unknown) => setError(errorMessage(e)));
    window.qa.db.status().then(setDb, (e: unknown) => setError(errorMessage(e)));
  }, []);

  async function check() {
    setChecking(true);
    try {
      const next = await window.qa.update.check();
      props.onStatus(next);
      // 맨 위 배너도 바로 바뀌게 알린다
      notifyUpdateStatus(next);
    } finally {
      setChecking(false);
    }
  }

  async function onPing(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      setPong((await window.qa.app.ping({ message })).message);
    } catch (e) {
      setPong(null);
      setError(errorMessage(e));
    }
  }

  return (
    <section className="card settings-detail" aria-labelledby="app-info-title">
      <SectionHead id="app-info-title" title="앱 정보">
        버전과 업데이트, 문제를 알릴 때 필요한 정보입니다.
      </SectionHead>
      <div className="settings-body">
        <div className="stack" data-testid="version-section">
          <strong className="group-label">버전</strong>
          <div className="row center">
            <span className="grow">
              Avocado <strong data-testid="settings-version">{status?.current ?? "확인 중"}</strong>
              {status?.latest ? ` · 최신 릴리스 ${status.latest}` : ""}
              {status?.available ? " · 새 버전이 있습니다(위 배너에서 받기)" : ""}
            </span>
            <button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
              {checking ? "확인 중" : "새 버전 확인"}
            </button>
          </div>
          {status ? (
            <small className="hint">
              새 버전은 {status.source} 의 Releases 에서 확인합니다
              {status.checkedAt ? ` · 마지막 확인 ${new Date(status.checkedAt).toLocaleString("ko-KR")}` : ""}
            </small>
          ) : null}
          {status?.error ? <small className="warning">{status.error}</small> : null}
        </div>

        <hr className="rule" />
        <strong className="group-label">진단</strong>
        {info ? (
          <dl>
            <dt>버전</dt>
            <dd data-testid="settings-app-version">{info.version}</dd>
            <dt>Electron</dt>
            <dd data-testid="electron-version">{info.versions.electron}</dd>
            <dt>Node</dt>
            <dd>{info.versions.node}</dd>
            <dt>플랫폼</dt>
            <dd>
              {info.platform} / {info.arch}
            </dd>
            <dt>로컬 DB</dt>
            <dd data-testid="db-status">{db ? `스키마 v${db.schemaVersion}/${db.latestVersion} · ${db.journalMode} · 테이블 ${db.tables.length}개` : "확인 중"}</dd>
          </dl>
        ) : (
          <p className="hint">불러오는 중</p>
        )}
        <form className="row" onSubmit={onPing} aria-label="진단">
          <label className="grow">
            IPC 확인 메시지
            <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} />
          </label>
          <button type="submit" className="secondary">
            보내기
          </button>
          <output data-testid="pong">{pong}</output>
        </form>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <p className="hint">문제를 알릴 때 이 정보를 함께 보내 주세요.</p>
      </div>
    </section>
  );
}
