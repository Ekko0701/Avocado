import type { AgentProvider, Device, GitHubSettings, InstallProgress, MaestroVerify, RemoteVerify, SecretsList, SetupReport, ToolId, WorkspaceStatus } from "@qa/shared";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ClaudeConnectionPanel } from "../components/ClaudeConnectionPanel";
import { GitHubRepoPicker } from "../components/GitHubRepoPicker";
import { SecretRow } from "../components/SecretRow";
import { errorMessage } from "../lib/errors";

// PLAN 11장 순서. 워크스페이스 clone 은 git 점검 뒤에 둔다(환경 점검이 git 을 본다).
// 첫 단계는 Claude 연결(D17, ADR 0022): 기본은 각자의 Claude 앱이고, API 키는 API 키 방식을 고를 때만 묻는다
const STEPS = ["Claude 연결", "GitHub 토큰", "환경 점검·도구", "GitHub·워크스페이스", "QA 기기", "완료"] as const;

const STATUS_TEXT = { ok: "정상", warn: "선택", fail: "필요" } as const;
const PHASE_TEXT: Record<InstallProgress["phase"], string> = {
  idle: "대기",
  downloading: "내려받는 중",
  verifying: "체크섬 확인 중",
  extracting: "압축 푸는 중",
  done: "완료",
  error: "실패",
};

/** "나중에 하기"(마법사 닫기). 단계마다 아래 붙박이 줄에 둔다 */
const WizardClose = createContext<(() => void) | null>(null);

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

export function SetupWizard(props: { onFinished: () => void; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [secrets, setSecrets] = useState<SecretsList | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadSecrets = useCallback(async () => {
    try {
      setSecrets(await window.qa.secrets.list());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const reloadProvider = useCallback(async () => {
    try {
      setProvider((await window.qa.settings.get()).settings.agent.provider);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reloadSecrets();
    void reloadProvider();
  }, [reloadSecrets, reloadProvider]);

  const secret = (name: string) => secrets?.items.find((s) => s.name === name);
  const anthropic = secret("anthropicApiKey");
  const github = secret("githubToken");

  return (
    <WizardClose.Provider value={props.onClose}>
    <div className="split-page wizard-page">
      <h1>설정 마법사</h1>
      <ol className="card phase-steps" aria-label="마법사 단계" style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}>
        {STEPS.map((title, i) => {
          const state = i < step ? "done" : i === step ? "active" : "pending";
          return (
            <li key={title} className={`step-node ${state}`} data-state={state} aria-current={i === step ? "step" : undefined}>
              <div className="step-node-track">
                {/* 지나온 단계는 눌러서 돌아갈 수 있다 */}
                {i < step ? (
                  <button type="button" className="step-node-mark" aria-label={`${i + 1}단계 ${title}(으)로 돌아가기`} onClick={() => setStep(i)}>
                    <CheckMark />
                  </button>
                ) : (
                  <span className="step-node-mark">{i + 1}</span>
                )}
                {i < STEPS.length - 1 ? <span className="step-node-line" /> : null}
              </div>
              <strong>{title}</strong>
              <small>{i < step ? "끝" : i === step ? "지금" : ""}</small>
            </li>
          );
        })}
      </ol>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      {step === 0 && anthropic && provider ? (
        <StepCard label="Claude 연결 단계" step={0} nav={<WizardNav onNext={() => setStep(1)} nextLabel="다음" />}>
          <p className="hint">
            플로우 만들기와 화면 판정은 각자 쓰는 Claude(데스크톱 앱·Claude Code)가 하고, 사용량은 각자의 Claude 요금제 한도에서 나갑니다. 여기서 Claude 에 Avocado 를 등록합니다.
            지금 못 하면 나중에 설정의 Claude 구역에서 할 수 있습니다.
          </p>
          <ClaudeConnectionPanel
            key={provider}
            provider={provider}
            onSaved={reloadProvider}
            apiKeySlot={<SecretRow status={anthropic} label="Anthropic API 키" disabled={!secrets?.encryptionAvailable} onChanged={reloadSecrets} />}
          />
        </StepCard>
      ) : null}

      {step === 1 && github ? (
        <StepCard label="GitHub 토큰 단계" step={1} nav={<WizardNav onBack={() => setStep(0)} onNext={() => setStep(2)} nextLabel={github.stored ? "다음" : "건너뛰기"} />}>
          <p className="hint">
            워크스페이스(qa-workspace)와 증적 저장소에 접근합니다. 권한: Contents·Pull requests 읽기·쓰기, Metadata 읽기. 조직 이름과 연결 확인은 설정 메뉴의 GitHub 에서 합니다(docs/user-guide/install.md 3절).
          </p>
          <SecretRow status={github} label="GitHub 토큰" disabled={!secrets?.encryptionAvailable} onChanged={reloadSecrets} />
        </StepCard>
      ) : null}

      {step === 2 ? <EnvironmentStep onBack={() => setStep(1)} onNext={() => setStep(3)} /> : null}

      {step === 3 ? <WorkspaceStep tokenStored={github?.stored ?? false} onBack={() => setStep(2)} onNext={() => setStep(4)} /> : null}

      {step === 4 ? <DeviceStep onBack={() => setStep(3)} onNext={() => setStep(5)} /> : null}

      {step === 5 ? (
        <FinishStep onBack={() => setStep(4)} onFinished={props.onFinished} keysMissing={!github?.stored || (provider === "api" && !anthropic?.stored)} />
      ) : null}

    </div>
    </WizardClose.Provider>
  );
}

function CheckMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** 단계 하나: 제목 · 본문(스크롤) · 아래 붙박이 줄(나중에 하기, 이전, 다음) */
function StepCard(props: { label: string; step: number; nav: ReactNode; children: ReactNode }) {
  return (
    <section className="card pane wizard-step" aria-label={props.label}>
      <div className="pane-head">
        <h2>
          {props.step + 1}. {STEPS[props.step]}
        </h2>
      </div>
      <div className="pane-body">{props.children}</div>
      <div className="pane-foot">{props.nav}</div>
    </section>
  );
}

function WizardNav(props: { onBack?: () => void; onNext: () => void; nextLabel: string; nextDisabled?: boolean }) {
  const close = useContext(WizardClose);
  return (
    <>
      {close ? (
        <button type="button" className="secondary wizard-later" onClick={close}>
          나중에 하기
        </button>
      ) : null}
      {props.onBack ? (
        <button type="button" className="secondary" onClick={props.onBack}>
          이전
        </button>
      ) : null}
      <button type="button" onClick={props.onNext} disabled={props.nextDisabled}>
        {props.nextLabel}
      </button>
    </>
  );
}

/**
 * 저장소 고르기·연결 확인과 워크스페이스 clone(PLAN 11장 (2)·(3)). 저장소 이름은 사용자마다 달라 토큰으로 볼 수 있는 목록에서 고른다.
 * 건너뛰고 나중에 설정·워크스페이스 메뉴에서 해도 된다
 */
function WorkspaceStep(props: { tokenStored: boolean; onBack: () => void; onNext: () => void }) {
  const [github, setGithub] = useState<GitHubSettings | null>(null);
  const [verify, setVerify] = useState<RemoteVerify | null>(null);
  const [ws, setWs] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    window.qa.settings.get().then((s) => setGithub(s.settings.github), (e: unknown) => setMessage(errorMessage(e)));
    window.qa.workspace.status().then(setWs, () => undefined);
  }, []);

  async function act(label: string, f: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage(`${label}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <StepCard label="워크스페이스 단계" step={3} nav={<WizardNav onBack={props.onBack} onNext={props.onNext} nextLabel={ws?.connected ? "다음" : "건너뛰기"} />}>
      <p className="hint">
        토큰으로 볼 수 있는 저장소 목록에서 워크스페이스(테스트 케이스·플로우)와 연도별 증적 저장소를 고르고, 연결을 확인한 뒤 워크스페이스를 받습니다. 토큰이 없으면 건너뛰고 나중에
        합니다. 목록에 없는 저장소는 설정의 GitHub 에서 직접 입력할 수 있습니다.
      </p>
      {github ? (
        <GitHubRepoPicker
          github={github}
          tokenStored={props.tokenStored}
          onSaved={(next) =>
            act("연결 확인", async () => {
              setGithub(next);
              setVerify(await window.qa.remote.verify());
              setWs(await window.qa.workspace.status());
            })
          }
        />
      ) : null}
      {verify ? (
        <ul className="checks" data-testid="wizard-github-verify">
          <li>로그인: {verify.login}</li>
          {verify.repos.map((r) => (
            <li key={`${r.owner}/${r.repo}`} className={r.exists && r.canPush ? "" : "warning"}>
              {r.owner}/{r.repo}: {r.exists ? (r.canPush ? "읽기·쓰기" : "읽기만") : "없음 또는 권한 없음"}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={busy !== null || !ws?.repo || ws.connected}
          onClick={() => void act("워크스페이스 연결", async () => setWs(await window.qa.workspace.connect()))}
        >
          {ws?.connected ? "워크스페이스 연결됨" : busy === "워크스페이스 연결" ? "받는 중" : "워크스페이스 연결(clone)"}
        </button>
        {ws?.connected ? (
          <small className="hint" data-testid="wizard-workspace">
            {ws.repo} · {ws.branch}
          </small>
        ) : null}
      </div>
      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}
    </StepCard>
  );
}

/** QA 기기 준비(PLAN 11장 (5)). 건너뛰고 나중에 기기 메뉴에서 해도 된다 */
function DeviceStep(props: { onBack: () => void; onNext: () => void }) {
  const [device, setDevice] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function prepare() {
    setBusy(true);
    setMessage(null);
    try {
      setDevice(await window.qa.devices.prepareIos({}));
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard label="QA 기기 단계" step={4} nav={<WizardNav onBack={props.onBack} onNext={props.onNext} nextLabel={device ? "다음" : "건너뛰기"} />}>
      <p className="hint">앱 전용 iOS 시뮬레이터를 만들고 설정의 기기 언어로 맞춰 부팅합니다(1~3분). Android 는 기기 메뉴에서 준비합니다.</p>
      <div className="row">
        <button type="button" className="secondary" disabled={busy} onClick={() => void prepare()}>
          {busy ? "준비 중" : "iOS 시뮬레이터 준비"}
        </button>
        {device ? (
          <small className="hint" data-testid="wizard-device">
            {device.name} · {device.osVersion} · {device.state}
          </small>
        ) : null}
      </div>
      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}
    </StepCard>
  );
}

function EnvironmentStep(props: { onBack: () => void; onNext: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState<ToolId | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [verify, setVerify] = useState<MaestroVerify | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      setReport(await window.qa.setup.check());
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => {
      window.qa.setup
        .progress()
        .then(setProgress)
        .catch(() => undefined);
    }, 400);
    return () => clearInterval(timer);
  }, [installing]);

  async function install(tools: ToolId[]) {
    setMessage(null);
    for (const tool of tools) {
      setInstalling(tool);
      try {
        await window.qa.setup.installTool({ tool });
      } catch (e) {
        setMessage(`${tool} 설치 실패: ${errorMessage(e)}`);
        break;
      }
    }
    setInstalling(null);
    setProgress(await window.qa.setup.progress());
    await runCheck();
  }

  async function verifyMaestro() {
    setVerify(null);
    try {
      setVerify(await window.qa.setup.verifyMaestro());
    } catch (e) {
      setVerify({ ok: false, version: null, detail: errorMessage(e) });
    }
  }

  const missing = report?.tools.filter((t) => !t.installed).map((t) => t.id) ?? [];
  const toolsReady = report !== null && missing.length === 0;

  return (
    <StepCard label="환경 점검 단계" step={2} nav={<WizardNav onBack={props.onBack} onNext={props.onNext} nextLabel="다음" />}>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void runCheck()} disabled={checking || installing !== null}>
          {checking ? "점검 중" : "다시 점검"}
        </button>
        {missing.length > 0 ? (
          <button type="button" onClick={() => void install(missing)} disabled={installing !== null}>
            필요한 도구 모두 설치
          </button>
        ) : null}
      </div>

      {report ? (
        <ul className="checks" aria-label="점검 결과">
          {report.checks.map((c) => (
            <li key={c.id} data-testid={`check-${c.id}`} className={`check ${c.status}`}>
              <span className={`badge ${c.status === "ok" ? "ok" : c.status === "warn" ? "" : "bad"}`} data-testid="check-status">
                {STATUS_TEXT[c.status]}
              </span>
              <div className="check-body">
                <strong>{c.label}</strong>
                <small className="hint">{c.detail}</small>
                {c.fix ? <small>할 일: {c.fix}</small> : null}
              </div>
              {c.tool ? (
                <button type="button" onClick={() => void install([c.tool as ToolId])} disabled={installing !== null}>
                  설치
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>점검 중</p>
      )}

      {installing || (progress && progress.phase !== "idle") ? (
        <div className="progress" data-testid="install-progress">
          <span>
            {progress?.tool ?? installing}: {PHASE_TEXT[progress?.phase ?? "downloading"]}
            {progress?.totalBytes ? ` · ${mb(progress.receivedBytes)} / ${mb(progress.totalBytes)}` : ""}
          </span>
          {progress?.totalBytes ? <progress max={progress.totalBytes} value={progress.receivedBytes} /> : null}
          {progress?.phase === "error" && progress.message ? <small className="error">{progress.message}</small> : null}
        </div>
      ) : null}

      <div className="row">
        <button type="button" onClick={() => void verifyMaestro()} disabled={!toolsReady || installing !== null}>
          Maestro 실행 확인
        </button>
        {verify ? (
          <span data-testid="maestro-verify" className={verify.ok ? "ok-text" : "error"}>
            {verify.ok ? `Maestro ${verify.version} 실행됨` : `실패: ${verify.detail}`}
          </span>
        ) : null}
      </div>

      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}
    </StepCard>
  );
}

function FinishStep(props: { onBack: () => void; onFinished: () => void; keysMissing: boolean }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    window.qa.setup
      .check()
      .then(setReport)
      .catch((e: unknown) => setMessage(errorMessage(e)));
  }, []);

  async function finish() {
    try {
      await window.qa.setup.complete();
      props.onFinished();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  const failed = report?.checks.filter((c) => c.required && c.status !== "ok") ?? [];
  return (
    <StepCard label="완료 단계" step={5} nav={<WizardNav onBack={props.onBack} onNext={() => void finish()} nextLabel="마법사 완료" nextDisabled={!report?.ready} />}>
      {report === null ? <p>확인 중</p> : null}
      {report && failed.length === 0 ? <p className="ok-text">필수 환경이 모두 준비됐습니다.</p> : null}
      {failed.length > 0 ? (
        <p className="error">아직 필요한 항목: {failed.map((c) => c.label).join(", ")}</p>
      ) : null}
      {props.keysMissing ? <p className="hint">GitHub 토큰(API 키 방식이면 Anthropic API 키)은 나중에 설정 화면에서 넣을 수 있습니다.</p> : null}
      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}
    </StepCard>
  );
}
