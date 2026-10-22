import type { AgentProvider, AgentUsage, AuthorJob, Build, ClaudeConnection, Device, TestcaseSummary } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { ClaudeRequest } from "../components/ClaudeRequest";
import { errorMessage } from "../lib/errors";

const PHASE: Record<AuthorJob["phase"], string> = {
  preparing: "준비",
  waiting_claude: "Claude 대기",
  exploring: "기기 탐색",
  checking: "규약 검사",
  replaying: "재생 확인",
  saving: "커밋",
  done: "끝",
};
const JOB_STATUS: Record<string, string> = {
  queued: "대기",
  running: "진행 중",
  succeeded: "완료",
  failed: "실패",
  canceled: "취소",
  budget_exceeded: "예산 초과",
};
const TARGETS = ["ios", "android"] as const;
const isRunning = (j: AuthorJob | null) => j !== null && (j.job.status === "queued" || j.job.status === "running");

/** 플로우 만들기(PLAN 6.5): TC 를 골라 에이전트가 기기에서 플로우를 만들고, 앱이 2회 재생으로 확인한 뒤 작업 브랜치에 커밋한다 */
export function AuthorPage(props: { onOpenResults?: (runId: string) => void }) {
  const [testcases, setTestcases] = useState<TestcaseSummary[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [keyStored, setKeyStored] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [tcKey, setTcKey] = useState("");
  const [target, setTarget] = useState<(typeof TARGETS)[number]>("ios");
  const [deviceId, setDeviceId] = useState("");
  const [buildId, setBuildId] = useState("");
  const [job, setJob] = useState<AuthorJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    else setMessage(`TC 목록을 읽지 못했습니다: ${errorMessage(tc.reason)}`);
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
  const canStart = tc !== null && targets.includes(target) && usableDevices.some((d) => d.id === deviceId) && ready && !busy && !running;

  async function start() {
    if (!tc) return;
    setBusy(true);
    setMessage(null);
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
      setMessage(pr.existing ? `이 TC 의 열린 PR #${pr.number} 에 올렸습니다: ${pr.url}` : `검토 요청을 만들었습니다: PR #${pr.number} ${pr.url}`);
    } catch (e) {
      setMessage(`검토 요청을 만들지 못했습니다: ${errorMessage(e)}`);
    }
  }

  return (
    <>
      <h1>플로우 만들기</h1>
      <section className="card stack" aria-label="플로우 만들기 준비">
        <p className="hint">
          에이전트가 TC 를 기기에서 따라가며 Maestro 플로우를 만들고, 앱이 규약 검사와 2회 재생으로 확인한 뒤 작업 브랜치에 커밋합니다. 계정 값은 키 이름으로만 에이전트에게
          보입니다.
          {viaClaude ? " 탐색은 각자의 Claude 앱(데스크톱·Code)이 합니다. 시작하면 Claude 에 붙여 넣을 요청이 나오고, 사용량은 각자의 Claude 요금제 한도에서 나갑니다." : null}
        </p>
        {viaClaude && claude && !claude.listening ? (
          <p role="alert" className="warning" data-testid="author-claude-closed">
            Claude 연결을 열지 못했습니다{claude.error ? `: ${claude.error}` : ""}. 설정의 "Claude 연결"을 확인합니다.
          </p>
        ) : null}
        {!viaClaude && keyStored === false ? (
          <p role="alert" className="warning" data-testid="author-no-key">
            Anthropic API 키가 없습니다. 설정에서 저장한 뒤 시작합니다.
          </p>
        ) : null}
        {!viaClaude && overBudget ? (
          <p role="alert" className="warning">
            이번 달 LLM 비용 상한에 닿았습니다. 설정에서 상한을 확인합니다.
          </p>
        ) : null}
        <div className="grid">
          <label>
            TC
            <select value={tcKey} onChange={(e) => setTcKey(e.target.value)}>
              <option value="">선택</option>
              {testcases.map((t) => (
                <option key={`${t.app}/${t.id}`} value={`${t.app}/${t.id}`}>
                  {t.app} · {t.id} {t.title ?? ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            타깃
            <select value={target} onChange={(e) => setTarget(e.target.value as (typeof TARGETS)[number])}>
              {TARGETS.map((t) => (
                <option key={t} value={t} disabled={tc !== null && !targets.includes(t)}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            기기(실행 중)
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">선택</option>
              {usableDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.osVersion}
                </option>
              ))}
            </select>
          </label>
          <label>
            빌드(선택)
            <select value={buildId} onChange={(e) => setBuildId(e.target.value)}>
              <option value="">기기에 설치된 앱</option>
              {usableBuilds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.appId} {b.version} ({b.buildNumber})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <button type="button" disabled={!canStart} onClick={() => void start()}>
            {viaClaude ? "Claude 로 플로우 만들기" : "플로우 만들기"}
          </button>
          {running ? (
            <button type="button" className="secondary" onClick={() => void cancel()}>
              취소
            </button>
          ) : null}
          {viaClaude ? (
            <small className="hint">Claude 요금제 한도 사용 · 연결된 Claude {claude?.clients.length ?? 0}개</small>
          ) : usage ? (
            <small className="hint">
              이번 달 ${usage.costUsd.toFixed(2)} / ${usage.monthlyBudgetUsd.toFixed(2)} · 작업당 상한 $5
            </small>
          ) : null}
        </div>
        {message ? (
          <p role="status" className="hint" data-testid="author-message">
            {message}
          </p>
        ) : null}
      </section>

      {job ? <AuthorJobView job={job} onRequestReview={() => void requestReview()} onOpenResults={props.onOpenResults} /> : null}
    </>
  );
}

function AuthorJobView(props: { job: AuthorJob; onRequestReview: () => void; onOpenResults?: (runId: string) => void }) {
  const { job } = props;
  const s = job.job;
  return (
    <section className="card stack" aria-label="플로우 만들기 진행" data-testid="author-job">
      <div className="row">
        <strong>
          {job.tcId} · {job.target}
        </strong>
        <span className={s.status === "succeeded" ? "badge ok" : s.status === "running" || s.status === "queued" ? "badge" : "badge bad"}>{JOB_STATUS[s.status] ?? s.status}</span>
        <span className="hint">
          {PHASE[job.phase]} · 시도 {job.attempt}/2 · 스텝 {job.step}/{job.totalSteps} · 도구 {s.toolCalls}회
          {job.driver === "claude-app" ? ` · Claude 앱${job.claudeClient ? `(${job.claudeClient})` : ""}` : ` · $${s.costUsd.toFixed(3)}`}
        </span>
      </div>
      {job.claudeRequest ? (
        <ClaudeRequest
          text={job.claudeRequest}
          testId="author-claude-request"
          hint={
            job.phase === "waiting_claude" || job.phase === "preparing"
              ? "Claude 데스크톱 앱이나 Claude Code 에 아래 요청을 붙여 넣습니다. Claude 가 작업을 맡으면 여기에 진행이 보입니다."
              : "Claude 가 작업을 진행하고 있습니다. 연결이 끊기면 아래 요청을 다른 대화에 붙여 넣어 이어갈 수 있습니다."
          }
        />
      ) : null}
      {s.error ? (
        <p role="alert" className="error">
          {s.error}
        </p>
      ) : null}
      {job.result ? (
        <div className="row" data-testid="author-result">
          <span>
            {job.result.flowPath} → <strong>{job.result.branch}</strong> ({job.result.commit})
            {job.result.unchanged
              ? job.result.branch === "main"
                ? " · 이미 승인된 플로우와 같아 새로 커밋하지 않았습니다"
                : " · 같은 플로우가 이미 커밋돼 있어 새로 커밋하지 않았습니다"
              : null}
          </span>
          {job.result.branch !== "main" ? (
            <button type="button" onClick={props.onRequestReview}>
              검토 요청
            </button>
          ) : null}
          {props.onOpenResults ? (
            <button type="button" className="secondary" onClick={() => props.onOpenResults?.(job.result?.goldenRunId ?? "")}>
              골든 런 보기
            </button>
          ) : null}
        </div>
      ) : null}
      {job.replays.length > 0 ? (
        <p className="hint">재생: {job.replays.map((r, i) => `${i + 1}번 ${r.status}${r.flaky ? "(불안정)" : ""}`).join(", ")}</p>
      ) : null}
      {job.lint.length > 0 ? (
        <ul className="checks">
          {job.lint.map((l, i) => (
            <li key={i} className={l.level === "error" ? "error" : "warning"}>
              {l.line ? `${l.line}줄 ` : ""}
              {l.message}
            </li>
          ))}
        </ul>
      ) : null}
      {job.submission ? (
        <>
          <h3>플로우 초안 (확신도 {Math.round(job.submission.confidence * 100)}%)</h3>
          <div className="log">
            {job.submission.yaml.split("\n").map((line, i) => (
              <div key={i} className="log-line">
                <span className="ln">{i + 1}</span>
                {line}
              </div>
            ))}
          </div>
          {job.submission.missingIdentifiers.length > 0 ? (
            <>
              <h3>식별자 누락</h3>
              <table className="matrix">
                <thead>
                  <tr>
                    <th>화면</th>
                    <th>요소</th>
                    <th>대신 쓴 선택자</th>
                  </tr>
                </thead>
                <tbody>
                  {job.submission.missingIdentifiers.map((m, i) => (
                    <tr key={i}>
                      <td>{m.screenKey}</td>
                      <td>{m.description}</td>
                      <td>{m.fallbackSelector}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {job.submission.questions.length > 0 ? (
            <>
              <h3>기획자 질문</h3>
              <ul>
                {job.submission.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
      <details>
        <summary>진행 기록 ({job.log.length})</summary>
        <div className="log">
          {job.log.map((l, i) => (
            <div key={i} className="log-line">
              <span className="ln">{new Date(l.at).toLocaleTimeString("ko-KR", { hour12: false })}</span>
              {l.message}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
