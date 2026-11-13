import type { AgentProvider, AgentUsage, AuthorJob, Build, ClaudeConnection, Device, TestcaseSummary } from "@qa/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { authorSteps, failedReplayRun, stoppedTitle, type AuthorStep } from "../lib/author-steps";
import { buildLabel } from "../lib/build-label";
import { AUTHOR_PHASE_TEXT, elapsed } from "../lib/dashboard";
import { errorMessage } from "../lib/errors";
import { deviceLabel } from "../lib/device-label";
import { TARGET_LABEL } from "../lib/results";
import { useDevicePolling } from "../lib/use-device-polling";

const JOB_STATUS: Record<string, string> = {
  queued: "대기",
  running: "진행 중",
  succeeded: "완료",
  failed: "실패",
  canceled: "취소",
  budget_exceeded: "예산 초과",
};
const TARGETS = ["ios", "android"] as const;
type Target = (typeof TARGETS)[number];
type ResultTab = "draft" | "missing" | "questions" | "log";
/** 진행 기록의 시각: "10:02:41" */
const clock = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const isRunning = (j: AuthorJob | null) => j !== null && (j.job.status === "queued" || j.job.status === "running");
const INTRO: { title: string; body: string }[] = [
  { title: "계정 값은 Claude 에게 보이지 않습니다.", body: "키 이름으로만 전달하고, 화면과 로그에 나온 값은 가려서 보냅니다." },
  { title: "main 에는 바로 들어가지 않습니다.", body: "두 번 재생해 모두 통과한 플로우만 작업 브랜치에 커밋하고, PR 로 승인받습니다." },
];

/**
 * 플로우 만들기(PLAN 6.5): TC 를 골라 에이전트가 기기에서 플로우를 만들고, 앱이 2회 재생으로 확인한 뒤 작업 브랜치에 커밋한다.
 * 왼쪽은 만들 것·만들 곳, 오른쪽은 단계 표시줄과 지금 단계에 맞는 내용(요청 붙여 넣기 → 진행 → 결과)이다
 */
export function AuthorPage(props: { onOpenResults?: (runId: string) => void }) {
  const [testcases, setTestcases] = useState<TestcaseSummary[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [keyStored, setKeyStored] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [tcKey, setTcKey] = useState("");
  const [target, setTarget] = useState<Target>("ios");
  const [deviceId, setDeviceId] = useState("");
  const [buildId, setBuildId] = useState("");
  const [job, setJob] = useState<AuthorJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [prMessage, setPrMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 기기를 꽂거나 빼면 새로고침 없이 기기 고르기에 반영한다(실행 중인·연결된 기기만)
  useDevicePolling((l) => setDevices(l.devices.filter((x) => x.state === "booted")));
  const reload = useCallback(async () => {
    const [tc, d, b, s, u, st, c] = await Promise.allSettled([
      window.qa.workspace.testcases(),
      window.qa.devices.list(),
      window.qa.builds.list(),
      window.qa.secrets.list(),
      window.qa.agent.usage(),
      window.qa.settings.get(),
      window.qa.claude.status(),
    ]);
    if (tc.status === "fulfilled") setTestcases(tc.value.testcases.filter((t) => t.valid));
    else setMessage(`테스트 케이스 목록을 읽지 못했습니다: ${errorMessage(tc.reason)}`);
    if (d.status === "fulfilled") setDevices(d.value.devices.filter((x) => x.state === "booted"));
    if (b.status === "fulfilled") setBuilds(b.value);
    if (s.status === "fulfilled") setKeyStored(s.value.items.some((i) => i.name === "anthropicApiKey" && i.stored));
    if (u.status === "fulfilled") setUsage(u.value);
    if (st.status === "fulfilled") setProvider(st.value.settings.agent.provider);
    if (c.status === "fulfilled") setClaude(c.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 화면을 떠났다 돌아와도 진행 중인(없으면 이번 실행에서 마지막으로 한) 작업을 이어 본다. 그 사이 새로 시작했으면 덮지 않는다
  useEffect(() => {
    window.qa.agent.currentAuthor().then(
      (current) => {
        if (!current) return;
        setJob((prev) => prev ?? current);
        setTcKey((prev) => prev || `${current.app}/${current.tcId}`);
        setTarget(current.target);
      },
      (e: unknown) => setMessage(`진행 중인 작업을 읽지 못했습니다: ${errorMessage(e)}`),
    );
  }, []);

  // 진행 중이면 1.5초마다 상태를 읽는다
  const jobId = job?.job.id ?? null;
  const running = isRunning(job);
  useEffect(() => {
    if (!jobId || !running) return;
    const timer = setInterval(() => {
      window.qa.agent.authorStatus({ jobId }).then(setJob, (e: unknown) => setMessage(errorMessage(e)));
    }, 1500);
    return () => clearInterval(timer);
  }, [jobId, running]);

  const tc = testcases.find((t) => `${t.app}/${t.id}` === tcKey) ?? null;
  const targets = TARGETS.filter((t) => tc?.targets.includes(t));
  const usableDevices = devices.filter((d) => d.platform === target);
  const usableBuilds = builds.filter((b) => b.app === tc?.app && b.target === target);
  const viaClaude = provider === "claude-app";
  const overBudget = !viaClaude && usage !== null && usage.costUsd >= usage.monthlyBudgetUsd;
  // Claude 앱 방식(D17)은 키·비용 상한 대신 Claude 연결(소켓)이 열려 있어야 한다
  const ready = provider === null ? false : viaClaude ? claude?.listening === true : keyStored === true && !overBudget;
  const deviceChosen = usableDevices.some((d) => d.id === deviceId);
  const canStart = tc !== null && targets.includes(target) && deviceChosen && ready && !busy && !running;

  async function start() {
    if (!tc) return;
    setBusy(true);
    setMessage(null);
    setPrMessage(null);
    try {
      setJob(await window.qa.agent.startAuthor({ app: tc.app, tcId: tc.id, target, deviceId, buildId: buildId || null }));
    } catch (e) {
      setMessage(`시작하지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      setJob(await window.qa.agent.cancel({ jobId }));
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  async function requestReview() {
    if (!job?.result) return;
    try {
      const pr = await window.qa.workspace.requestReview({
        // 커밋한 작업 브랜치를 올린다(그 사이 화면에서 다른 브랜치로 바꿨어도)
        branch: job.result.branch,
        title: `flow: ${job.tcId} ${job.target} 플로우`,
        body: [
          `에이전트가 만든 ${job.tcId} ${job.target} 플로우입니다. 같은 기기에서 두 번 재생해 통과했습니다(골든 런 ${job.result.goldenRunId}).`,
          job.submission?.missingIdentifiers.length ? `\n식별자 누락 ${job.submission.missingIdentifiers.length}개는 ${job.result.flowPath.replace(/\.yaml$/, ".meta.yaml")} 에 있습니다.` : "",
          job.submission?.questions.length ? `\n기획자 질문:\n${job.submission.questions.map((q) => `- ${q}`).join("\n")}` : "",
        ].join(""),
      });
      setPrMessage(pr.existing ? `이 테스트 케이스의 열린 PR #${pr.number} 에 올렸습니다: ${pr.url}` : `PR #${pr.number} 을 만들었습니다: ${pr.url}`);
    } catch (e) {
      setPrMessage(`PR 을 만들지 못했습니다: ${errorMessage(e)}`);
    }
  }

  // 왼쪽에서 고른 것이 끝난 작업과 같은 테스트 케이스·타깃이면 그대로 다시 시작한다. 다르면 그 작업에 맞춰 놓고 기기를 고르게 한다
  function retry() {
    if (!job) return;
    const sameChoice = tcKey === `${job.app}/${job.tcId}` && target === job.target;
    if (sameChoice && canStart) return void start();
    setTcKey(`${job.app}/${job.tcId}`);
    setTarget(job.target);
    setMessage("왼쪽에서 기기를 확인한 뒤 다시 시작합니다.");
  }

  const hasFlow = tc?.flows.includes(target) ?? false;
  const driver: AuthorJob["driver"] = job?.driver ?? (viaClaude || provider === null ? "claude-app" : "api");
  const jobTitle = job ? (testcases.find((t) => t.app === job.app && t.id === job.tcId)?.title ?? null) : null;

  return (
    <div className="author-page">
      <h1>플로우 만들기</h1>
      <div className="author-panes">
        <section className="card author-setup" aria-label="플로우 만들기 준비">
          {viaClaude && claude && !claude.listening ? (
            <p role="alert" className="warning" data-testid="author-claude-closed">
              Claude 연결을 열지 못했습니다{claude.error ? `: ${claude.error}` : ""}. 설정의 Claude 구역을 확인합니다.
            </p>
          ) : null}
          {!viaClaude && keyStored === false ? (
            <p role="alert" className="warning" data-testid="author-no-key">
              Anthropic API 키가 없습니다. 설정의 Claude 구역에서 저장한 뒤 시작합니다.
            </p>
          ) : null}
          {!viaClaude && overBudget ? (
            <p role="alert" className="warning">
              이번 달 LLM 비용 상한에 닿았습니다. 설정의 Claude 구역에서 상한을 확인합니다.
            </p>
          ) : null}

          <h2>만들 것</h2>
          <label>
            테스트 케이스
            <select value={tcKey} disabled={running} onChange={(e) => setTcKey(e.target.value)}>
              <option value="">선택</option>
              {testcases.map((t) => (
                <option key={`${t.app}/${t.id}`} value={`${t.app}/${t.id}`}>
                  {t.app} · {t.id} {t.title ?? ""}
                </option>
              ))}
            </select>
          </label>
          <div role="tablist" aria-label="타깃">
            {TARGETS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={target === t} disabled={running || (tc !== null && !targets.includes(t))} onClick={() => setTarget(t)}>
                {TARGET_LABEL[t]}
              </button>
            ))}
          </div>
          <p className="hint author-note" data-testid="author-flow-note">
            {tc === null
              ? "테스트 케이스를 고르면 이 타깃의 플로우가 이미 있는지 알려 줍니다."
              : !targets.includes(target)
                ? `이 테스트 케이스는 ${TARGET_LABEL[target]} 타깃이 아닙니다.`
                : hasFlow
                  ? `${TARGET_LABEL[target]} 플로우가 이미 있습니다. 다시 만들면 작업 브랜치에 새로 커밋합니다.`
                  : `${TARGET_LABEL[target]} 플로우가 아직 없습니다. 만들면 작업 브랜치에 커밋합니다.`}
          </p>

          <hr className="rule" />
          <h2>만들 곳</h2>
          <label>
            기기(실행 중)
            <select value={deviceId} disabled={running} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">선택</option>
              {usableDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {deviceLabel(d)} · {d.osVersion}
                </option>
              ))}
            </select>
          </label>
          <label>
            빌드(선택)
            <select value={buildId} disabled={running} onChange={(e) => setBuildId(e.target.value)}>
              <option value="">기기에 설치된 앱</option>
              {usableBuilds.map((b) => (
                <option key={b.id} value={b.id}>
                  {buildLabel(b)}
                </option>
              ))}
            </select>
          </label>

          <hr className="rule" />
          <ul className="author-ready" aria-label="시작 조건">
            {provider === null ? null : viaClaude ? (
              <ReadyRow ok={claude?.listening === true} text={claude?.listening ? `Claude 연결 열림 · 연결된 Claude ${claude.clients.length}개` : "Claude 연결이 닫혀 있습니다"} />
            ) : (
              <ReadyRow
                ok={keyStored === true && !overBudget}
                text={keyStored !== true ? "Anthropic API 키가 없습니다" : usage ? `이번 달 $${usage.costUsd.toFixed(2)} / $${usage.monthlyBudgetUsd.toFixed(2)} · 작업당 상한 $5` : "API 키 저장됨"}
              />
            )}
            <ReadyRow
              ok={deviceChosen}
              text={deviceChosen ? "기기 켜짐" : usableDevices.length === 0 ? `실행 중인 ${TARGET_LABEL[target]} 기기가 없습니다. 기기 화면에서 켭니다.` : "기기를 고릅니다"}
            />
          </ul>

          <div className="author-setup-foot">
            {running ? (
              <>
                <button type="button" className="secondary" onClick={() => void cancel()}>
                  취소
                </button>
                <small className="hint">진행 중에는 다른 플로우를 시작할 수 없습니다.</small>
              </>
            ) : (
              <>
                {/* 끝난 작업이 오른쪽에 있으면 그쪽의 PR 작성·다시 만들기가 주 버튼이다 */}
                <button type="button" className={job ? "secondary" : undefined} disabled={!canStart} onClick={() => void start()}>
                  {viaClaude || provider === null ? "Claude 로 플로우 만들기" : "플로우 만들기"}
                </button>
                {provider === null ? null : <small className="hint">{viaClaude ? "Claude 요금제 한도 사용" : "LLM 비용이 듭니다"}</small>}
              </>
            )}
            {message ? (
              <p role="status" className="hint" data-testid="author-message">
                {message}
              </p>
            ) : null}
          </div>
        </section>

        {job ? (
          <AuthorJobView
            job={job}
            title={jobTitle}
            prMessage={prMessage}
            onRequestReview={() => void requestReview()}
            onRetry={retry}
            onOpenResults={props.onOpenResults}
          />
        ) : (
          <section className="card author-progress" aria-label="플로우 만들기 진행" data-testid="author-intro">
            <div className="author-progress-head">
              <h2>이렇게 진행됩니다</h2>
              <small className="hint">테스트 케이스와 기기를 고르고 시작하면 아래 순서로 진행합니다.</small>
            </div>
            <Stepper steps={authorSteps(null, driver)} />
            <div className="author-progress-body">
              <ul className="author-intro">
                <li>
                  <strong>{driver === "claude-app" ? "내가 할 일은 2번 하나입니다." : "시작한 뒤에는 할 일이 없습니다."}</strong>
                  <span className="hint">
                    {driver === "claude-app"
                      ? "시작하면 나오는 요청을 Claude 데스크톱 앱이나 Claude Code 에 붙여 넣습니다. 나머지는 Claude 와 Avocado 가 합니다."
                      : "앱이 API 로 기기를 탐색해 플로우를 만듭니다. 비용은 설정의 상한 안에서 씁니다."}
                  </span>
                </li>
                {INTRO.map((i) => (
                  <li key={i.title}>
                    <strong>{i.title}</strong>
                    <span className="hint">{i.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ReadyRow(props: { ok: boolean; text: string }) {
  return (
    <li className={props.ok ? "ok" : "wait"}>
      <span className="author-ready-mark" aria-hidden="true">
        {props.ok ? <CheckMark /> : null}
      </span>
      <span>{props.text}</span>
    </li>
  );
}

function CheckMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const STATE_TEXT: Record<AuthorStep["state"], string> = { done: "끝남", active: "진행 중", mine: "내 차례", failed: "멈춤", pending: "대기" };

function Stepper(props: { steps: AuthorStep[] }) {
  return (
    <ol className="phase-steps" aria-label="진행 단계" data-testid="author-steps" style={{ gridTemplateColumns: `repeat(${props.steps.length}, minmax(0, 1fr))` }}>
      {props.steps.map((s, i) => (
        <li key={s.phase} className={`step-node ${s.state}`} data-testid={`author-step-${s.phase}`} data-state={s.state} aria-current={s.state === "active" || s.state === "mine" || s.state === "failed" ? "step" : undefined}>
          <div className="step-node-track">
            <span className="step-node-mark" aria-label={STATE_TEXT[s.state]}>
              {s.state === "done" ? <CheckMark /> : s.state === "failed" ? "!" : i + 1}
            </span>
            {i < props.steps.length - 1 ? <span className="step-node-line" /> : null}
          </div>
          <strong>{s.label}</strong>
          <small>{s.sub}</small>
        </li>
      ))}
    </ol>
  );
}

function CopyRequest(props: { text: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={props.small ? "secondary small" : undefined}
        onClick={() =>
          void navigator.clipboard.writeText(props.text).then(
            () => setCopied("복사했습니다"),
            (e: unknown) => setCopied(`복사하지 못했습니다(글자를 직접 선택해 복사합니다): ${errorMessage(e)}`),
          )
        }
      >
        {props.label}
      </button>
      {copied ? (
        <small role="status" className="hint">
          {copied}
        </small>
      ) : null}
    </>
  );
}

function AuthorJobView(props: { job: AuthorJob; title: string | null; prMessage: string | null; onRequestReview: () => void; onRetry: () => void; onOpenResults?: (runId: string) => void }) {
  const { job } = props;
  const s = job.job;
  const running = isRunning(job);
  const [picked, setPicked] = useState<ResultTab | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const missing = job.submission?.missingIdentifiers ?? [];
  const questions = job.submission?.questions ?? [];
  const available: ResultTab[] = [...(job.submission ? (["draft"] as const) : []), ...(missing.length ? (["missing"] as const) : []), ...(questions.length ? (["questions"] as const) : []), "log"];
  // 진행 중에는 기록을, 끝나면 초안을 먼저 보인다. 고른 탭이 없어지면 기본으로 돌아간다
  const fallback: ResultTab = !running && job.submission ? "draft" : "log";
  const tab = picked && available.includes(picked) ? picked : fallback;
  const TAB_LABEL: Record<ResultTab, string> = {
    draft: job.submission ? `플로우 초안 (확신도 ${Math.round(job.submission.confidence * 100)}%)` : "플로우 초안",
    missing: `식별자 누락 ${missing.length}`,
    questions: `기획자 질문 ${questions.length}`,
    log: `진행 기록 ${job.log.length}`,
  };

  // 진행 중에는 새 기록 줄을 따라간다
  const logCount = job.log.length;
  useEffect(() => {
    const box = logRef.current;
    if (box && running) box.scrollTop = box.scrollHeight;
  }, [logCount, running, tab]);

  const waiting = running && job.claudeRequest !== null && (job.phase === "waiting_claude" || job.phase === "preparing");
  const failedRun = failedReplayRun(job);
  const took = elapsed(s.createdAt, s.finishedAt ? new Date(s.finishedAt) : new Date());
  const badgeClass = s.status === "succeeded" ? "badge ok" : running ? "badge" : "badge bad";

  return (
    <section className="card author-progress" aria-label="플로우 만들기 진행" data-testid="author-job">
      <div className="author-progress-head">
        <h2>
          {job.tcId} · {TARGET_LABEL[job.target]} <span className={badgeClass}>{JOB_STATUS[s.status] ?? s.status}</span>
        </h2>
        <small className="hint" data-testid="author-meta">
          {props.title ? `${props.title} · ` : ""}
          {job.attempt > 0 ? `시도 ${job.attempt}/2 · ` : ""}도구 {s.toolCalls}회 · {took}
          {job.driver === "claude-app" ? (job.claudeClient ? ` · Claude 앱(${job.claudeClient})` : "") : ` · $${s.costUsd.toFixed(3)}`}
        </small>
      </div>
      <Stepper steps={authorSteps(job, job.driver)} />

      <div className="author-progress-body">
        {waiting && job.claudeRequest ? (
          <div className="callout accent" data-testid="author-claude-request">
            <div className="callout-text">
              <strong>내 차례: Claude 에 이 요청을 붙여 넣으세요</strong>
              <span className="hint">Claude 데스크톱 앱이나 Claude Code 의 새 대화에 붙여 넣습니다. Claude 가 작업을 맡으면 이 화면이 다음 단계로 넘어갑니다.</span>
            </div>
            <code className="callout-code" data-testid="author-claude-request-text">
              {job.claudeRequest}
            </code>
            <div className="row center">
              <CopyRequest text={job.claudeRequest} label="요청 복사" />
            </div>
          </div>
        ) : null}

        {running && !waiting ? (
          <div className="author-now" data-testid="author-now">
            <div className="author-now-title">
              <strong>{AUTHOR_PHASE_TEXT[job.phase]}</strong>
              {job.phase === "exploring" && job.totalSteps > 0 ? (
                <span className="hint">
                  스텝 {job.step} / {job.totalSteps}
                </span>
              ) : null}
            </div>
            {job.phase === "exploring" && job.totalSteps > 0 ? (
              <div className="meter" role="progressbar" aria-label="테스트 케이스 스텝 진행" aria-valuemin={0} aria-valuemax={job.totalSteps} aria-valuenow={job.step}>
                <div style={{ width: `${Math.min(100, (job.step / job.totalSteps) * 100)}%` }} />
              </div>
            ) : null}
            {job.claudeRequest ? (
              <div className="row center" data-testid="author-claude-recopy">
                <small className="hint">Claude 대화가 끊겼나요? 다른 대화에 같은 요청을 붙여 넣으면 이어서 합니다.</small>
                <CopyRequest text={job.claudeRequest} label="요청 다시 복사" small />
              </div>
            ) : null}
          </div>
        ) : null}

        {job.result ? (
          <div className="callout success" data-testid="author-result">
            <div className="callout-text">
              <strong>
                {job.result.unchanged
                  ? job.result.branch === "main"
                    ? "이미 승인된 플로우와 같아 새로 커밋하지 않았습니다"
                    : "같은 플로우가 이미 커밋돼 있어 새로 커밋하지 않았습니다"
                  : "플로우를 만들어 작업 브랜치에 커밋했습니다"}
              </strong>
              <span>
                <code>{job.result.flowPath}</code> → <strong>{job.result.branch}</strong> <span className="hint">({job.result.commit})</span>
              </span>
              <span className="hint">
                재생 2번 모두 통과
                {missing.length ? ` · 식별자 누락 ${missing.length}개` : ""}
                {questions.length ? ` · 기획자 질문 ${questions.length}개` : ""}
              </span>
            </div>
            <div className="row center">
              {job.result.branch !== "main" ? (
                <button type="button" onClick={props.onRequestReview}>
                  PR 작성
                </button>
              ) : null}
              {props.onOpenResults ? (
                <button type="button" className="secondary" onClick={() => props.onOpenResults?.(job.result?.goldenRunId ?? "")}>
                  골든 런 보기
                </button>
              ) : null}
            </div>
            {props.prMessage ? (
              <p role="status" className="hint" data-testid="author-pr-message">
                {props.prMessage}
              </p>
            ) : null}
          </div>
        ) : null}

        {!running && !job.result ? (
          <div className="callout danger" data-testid="author-stopped">
            <div className="callout-text">
              <strong>{stoppedTitle(job)}</strong>
              {s.error ? (
                <span role="alert" className="error-text">
                  {s.error}
                </span>
              ) : null}
              {failedRun ? <span className="hint">한 번이라도 실패한 플로우는 커밋하지 않습니다. 실패한 재생의 캡처와 로그를 확인한 뒤 다시 만듭니다.</span> : null}
            </div>
            <div className="row center">
              {failedRun && props.onOpenResults ? (
                <button type="button" onClick={() => props.onOpenResults?.(failedRun)}>
                  실패한 재생 보기
                </button>
              ) : null}
              <button type="button" className={failedRun && props.onOpenResults ? "secondary" : undefined} onClick={props.onRetry}>
                다시 만들기
              </button>
            </div>
          </div>
        ) : null}

        {job.replays.length > 0 ? (
          <div className="author-replays" data-testid="author-replays">
            <strong>재생</strong>
            {job.replays.map((r, i) => (
              <span key={r.runId} className={r.status === "passed" ? "badge ok" : "badge bad"}>
                {i + 1}번 {r.status === "passed" ? "통과" : r.status === "failed" ? "실패" : r.status}
                {r.flaky ? " (불안정)" : ""}
              </span>
            ))}
          </div>
        ) : null}

        {job.lint.length > 0 ? (
          <ul className="checks" aria-label="플로우 규약 검사">
            {job.lint.map((l, i) => (
              <li key={i} className={l.level === "error" ? "error" : "warning"}>
                {l.line ? `${l.line}줄 ` : ""}
                {l.message}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="author-tabs">
          <div role="tablist" aria-label="만든 결과">
            {available.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setPicked(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === "draft" && job.submission ? (
            <div className="log" data-testid="author-draft">
              {job.submission.yaml.split("\n").map((line, i) => (
                <div key={i} className="log-line">
                  <span className="ln">{i + 1}</span>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {tab === "missing" ? (
            <table className="matrix">
              <thead>
                <tr>
                  <th>화면</th>
                  <th>요소</th>
                  <th>대신 쓴 선택자</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((m, i) => (
                  <tr key={i}>
                    <td>{m.screenKey}</td>
                    <td>{m.description}</td>
                    <td>{m.fallbackSelector}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {tab === "questions" ? (
            <ul className="author-questions">
              {questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          ) : null}
          {tab === "log" ? (
            job.log.length > 0 ? (
              <div className="log" data-testid="author-log" ref={logRef}>
                {job.log.map((l, i) => (
                  <div key={i} className="log-line">
                    <span className="ln time">{clock(l.at)}</span>
                    {l.message}
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">{running ? "아직 기록이 없습니다." : "앱을 다시 시작해 진행 기록은 남아 있지 않습니다."}</p>
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}
