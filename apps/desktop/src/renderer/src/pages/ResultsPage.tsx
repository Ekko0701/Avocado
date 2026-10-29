import type { AgentProvider, ClaudeJudgeJob, EvidenceArtifact, EvidenceFile, EvidenceSearchResult, Execution, HierarchyView, Judgement, RunDetail, RunStep, RunSummary } from "@qa/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClaudeRequest } from "../components/ClaudeRequest";
import { EvidenceUploadPanel } from "../components/EvidenceUploadPanel";
import { errorMessage, formatDateTime } from "../lib/errors";

const RUN_STATUS: Record<RunSummary["status"], string> = { queued: "대기", running: "실행 중", passed: "통과", failed: "실패", error: "오류", canceled: "취소" };
const JUDGE_LABEL: Record<Judgement["verdict"], string> = { pass: "정상", fail: "결함", uncertain: "불확실" };
const STEP_STATUS: Record<RunStep["status"], string> = { completed: "완료", failed: "실패", warned: "경고", skipped: "건너뜀", pending: "대기", running: "실행 중" };
const FAILURE_CLASS: Record<string, string> = { env_issue: "환경 문제", flaky: "불안정", app_bug: "앱 버그", test_drift: "테스트 어긋남", unknown: "미분류" };
const LOG_KINDS: EvidenceArtifact["kind"][] = ["maestro_log", "console_log", "device_log", "runner_log", "junit"];
const LOG_LABEL: Record<string, string> = { maestro_log: "Maestro 로그", console_log: "콘솔", device_log: "기기 로그", runner_log: "드라이버 로그", junit: "JUnit" };
/** 로그를 열 때 처음 보여 줄 줄(실패 흔적) */
const FAILURE_LINE = /FAILED|Element not found|Assertion is false|Exception|Error:/;

const badge = (s: string) => (s === "passed" || s === "completed" ? "badge ok" : s === "failed" || s === "error" ? "badge bad" : "badge");
const seconds = (ms: number | null) => (ms === null ? "" : `${(ms / 1000).toFixed(1)}초`);
const title = (r: RunSummary) => (r.flowName.includes(r.tcId) ? r.flowName : `${r.tcId} · ${r.flowName}`);
const fileName = (p: string) => p.split("/").pop() ?? p;

/** 실패한 실행이면 실패 스텝, 아니면 마지막 캡처가 있는 스텝 */
function defaultStep(e: Execution | undefined): number | null {
  if (!e) return null;
  if (e.failure?.stepIndex != null) return e.failure.stepIndex;
  const withShot = [...e.steps].reverse().find((s) => s.failureScreenshot || s.screenshot);
  return withShot?.index ?? e.steps[0]?.index ?? null;
}

export function ResultsPage(props: { initialRunId?: string | null }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runId, setRunId] = useState<string | null>(props.initialRunId ?? null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<EvidenceArtifact[]>([]);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [capture, setCapture] = useState<EvidenceFile | null>(null);
  const [tree, setTree] = useState<HierarchyView | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [logPath, setLogPath] = useState<string | null>(null);
  const [log, setLog] = useState<EvidenceFile | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<EvidenceSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [judgements, setJudgements] = useState<Judgement[]>([]);
  /** 보관 표시를 바꾼 실행(저장 응답 전에도 바로 보이게). detail 을 바꾸지 않아 화면 상태가 초기화되지 않는다 */
  const [keptOverride, setKeptOverride] = useState<Record<string, boolean>>({});
  const [judging, setJudging] = useState(false);
  const [judgeMessage, setJudgeMessage] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  /** Claude 앱 방식 화면 판정 작업(ADR 0022) */
  const [claudeJudge, setClaudeJudge] = useState<ClaudeJudgeJob | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.qa.runs.list().then(setRuns, (e: unknown) => setError(errorMessage(e)));
    window.qa.settings.get().then((s) => setProvider(s.settings.agent.provider), (e: unknown) => setError(errorMessage(e)));
  }, []);

  // Claude 앱 방식 판정이 진행 중이면 1.5초마다 상태를 읽고, 판정이 늘면 배지를 다시 읽는다
  const claudeJobId = claudeJudge?.job.id ?? null;
  const claudeRunning = claudeJudge !== null && claudeJudge.phase !== "done";
  useEffect(() => {
    if (!claudeJobId || !claudeRunning) return;
    const timer = setInterval(() => {
      window.qa.agent.claudeJudgeStatus({ jobId: claudeJobId }).then(
        (next) => {
          setClaudeJudge((prev) => {
            if (prev && next.judged !== prev.judged) {
              window.qa.agent.judgements({ runId: next.runId, executionId: next.executionId }).then(setJudgements, (e: unknown) => setJudgeMessage(errorMessage(e)));
            }
            return next;
          });
          if (next.phase === "done") setJudgeMessage(`Claude 판정 ${next.judged}/${next.total}건 (${next.job.status === "succeeded" ? "끝" : next.job.error ?? next.job.status})`);
        },
        (e: unknown) => setJudgeMessage(errorMessage(e)),
      );
    }, 1500);
    return () => clearInterval(timer);
  }, [claudeJobId, claudeRunning]);

  // 실행을 고르면 마지막 회차와 기본 스텝(실패 스텝)을 연다
  useEffect(() => {
    if (!runId) return;
    let stale = false;
    window.qa.runs.get({ runId }).then(
      (d) => {
        if (stale) return;
        setDetail(d);
        const last = d.executions.at(-1);
        setExecutionId(last?.id ?? null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [runId]);

  const execution = detail?.executions.find((e) => e.id === executionId);

  // 회차를 바꾸면 산출물 목록, 기본 스텝, 기본 로그(Maestro 로그)를 다시 연다
  useEffect(() => {
    if (!runId || !executionId) return;
    let stale = false;
    setCapture(null);
    setTree(null);
    setLog(null);
    setFound(null);
    setStepIndex(defaultStep(detail?.executions.find((e) => e.id === executionId)));
    setJudgeMessage(null);
    window.qa.agent.judgements({ runId, executionId }).then(
      (list) => {
        if (!stale) setJudgements(list);
      },
      () => {
        if (!stale) setJudgements([]);
      },
    );
    window.qa.evidence.list({ runId, executionId }).then(
      (list) => {
        if (stale) return;
        setArtifacts(list);
        const first = LOG_KINDS.map((k) => list.find((a) => a.kind === k)).find(Boolean);
        setLogPath(first?.path ?? null);
      },
      (e: unknown) => {
        if (!stale) {
          setArtifacts([]);
          setLogPath(null);
          setError(errorMessage(e));
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [runId, executionId, detail]);

  const step = execution?.steps.find((s) => s.index === stepIndex);
  // 스텝별 마지막 판정(배지만, 실행 상태는 바꾸지 않는다 — PLAN 6.7)
  const judgementOf = (index: number) => judgements.filter((j) => j.stepIndex === index).at(-1);
  const stepJudgement = step ? judgementOf(step.index) : undefined;

  const viaClaude = provider === "claude-app";

  async function judgeNow() {
    if (!runId || !executionId) return;
    setJudging(true);
    setJudgeMessage(null);
    if (viaClaude) {
      try {
        setClaudeJudge(await window.qa.agent.startClaudeJudge({ runId, executionId }));
      } catch (e) {
        setJudgeMessage(`판정을 시작하지 못했습니다: ${errorMessage(e)}`);
      } finally {
        setJudging(false);
      }
      return;
    }
    try {
      const list = await window.qa.agent.judge({ runId, executionId });
      setJudgements(list);
      setJudgeMessage(list.length ? `판정 ${list.length}건` : "판정할 캡처가 없습니다");
    } catch (e) {
      setJudgeMessage(`판정하지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setJudging(false);
    }
  }
  const shotPath = step?.failureScreenshot ?? step?.screenshot ?? null;

  useEffect(() => {
    setTree(null);
    if (!runId || !executionId || !shotPath) {
      setCapture(null);
      return;
    }
    let stale = false;
    window.qa.evidence.file({ runId, executionId, path: shotPath }).then(
      (f) => !stale && setCapture(f),
      (e: unknown) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [runId, executionId, shotPath]);

  useEffect(() => {
    if (!runId || !executionId || !logPath) return;
    let stale = false;
    window.qa.evidence.file({ runId, executionId, path: logPath }).then(
      (f) => {
        if (stale) return;
        setLog(f);
        if (f.kind === "text" && focusLine === null) {
          const idx = f.text.split("\n").findIndex((l) => FAILURE_LINE.test(l));
          setFocusLine(idx >= 0 ? f.firstLine + idx : null);
        }
      },
      (e: unknown) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
    // focusLine 은 검색 결과로 정할 때도 있어 여기서 의존하지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, executionId, logPath]);

  // 로그 상자 안에서만 스크롤한다(페이지 전체가 움직이면 캡처·타임라인이 화면 밖으로 밀린다)
  const scrollLogToFocus = () => {
    const box = logBoxRef.current;
    const line = focusRef.current;
    if (box && line) box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 2);
  };
  useEffect(scrollLogToFocus, [log, focusLine]);

  const matrix = useMemo(() => {
    const rows = new Map<string, { title: string; ios?: RunSummary; android?: RunSummary }>();
    for (const r of runs ?? []) {
      const row = rows.get(r.tcId) ?? { title: title(r) };
      if (!row[r.target]) row[r.target] = r; // 목록은 최신순이라 처음 본 것이 최신
      rows.set(r.tcId, row);
    }
    return [...rows.entries()];
  }, [runs]);

  const maxDuration = Math.max(1, ...(execution?.steps.map((s) => s.durationMs ?? 0) ?? [1]));
  const logs = artifacts.filter((a) => LOG_KINDS.includes(a.kind));

  async function search() {
    if (!runId || !executionId || !query.trim()) return;
    try {
      setFound(await window.qa.evidence.search({ runId, executionId, query: query.trim() }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function showTree() {
    if (!runId || !executionId || !step?.hierarchy) return;
    try {
      setTree(await window.qa.evidence.hierarchy({ runId, executionId, path: step.hierarchy }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function openLine(path: string, line: number) {
    setFocusLine(line);
    if (path !== logPath) setLogPath(path);
    else scrollLogToFocus();
  }

  const pick = (id: string) => {
    setError(null);
    setFocusLine(null);
    setRunId(id);
  };

  return (
    <>
      <h1>결과</h1>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="card stack" aria-label="테스트 케이스별 최신 결과">
        <h2>테스트 케이스 × 타깃</h2>
        {matrix.length === 0 ? <p className="hint">실행 기록이 없습니다.</p> : null}
        {matrix.length > 0 ? (
          <table className="matrix">
            <thead>
              <tr>
                <th>테스트 케이스</th>
                <th>iOS</th>
                <th>Android</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map(([tc, row]) => (
                <tr key={tc}>
                  <td>{row.title}</td>
                  {(["ios", "android"] as const).map((t) => {
                    const r = row[t];
                    return (
                      <td key={t}>
                        {r ? (
                          <button type="button" className={`${badge(r.status)} cell`} data-testid={`tc-cell-${tc}-${t}`} onClick={() => pick(r.id)}>
                            {RUN_STATUS[r.status]}
                          </button>
                        ) : (
                          <span className="hint">-</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <div className="results">
        <section className="card stack run-list" aria-label="실행 목록">
          <h2>실행 목록</h2>
          {(runs ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === runId ? "run-item selected" : "run-item"}
              data-testid={`results-run-${r.id}`}
              onClick={() => pick(r.id)}
            >
              <span className={badge(r.status)}>{RUN_STATUS[r.status]}</span>
              <span className="run-item-body">
                <strong>{title(r)}</strong>
                <small className="hint">
                  {r.deviceName} · {formatDateTime(r.createdAt)}
                  {r.attempts > 1 ? ` · ${r.attempts}회` : ""}
                </small>
              </span>
            </button>
          ))}
        </section>

        <div className="stack">
          {detail ? (
            <section className="card stack" aria-label="스텝 타임라인" data-testid="results-detail">
              <h2>
                {title(detail)} <span className={badge(detail.status)}>{RUN_STATUS[detail.status]}</span>
                {detail.flaky ? <span className="badge"> 불안정</span> : null}
              </h2>
              <small className="hint">
                {detail.deviceName}
                {detail.buildLabel ? ` · ${detail.buildLabel}` : ""} · {formatDateTime(detail.createdAt)}
              </small>
              <label className="check">
                <input
                  type="checkbox"
                  data-testid="keep-run"
                  checked={keptOverride[detail.id] ?? detail.kept}
                  onChange={(e) => {
                    // 바로 반영하고, 저장에 실패하면 그 실행의 표시만 되돌린다
                    const keep = e.target.checked;
                    const runId = detail.id;
                    setKeptOverride((o) => ({ ...o, [runId]: keep }));
                    window.qa.runs.setKeep({ runId, keep }).catch((err: unknown) => {
                      setKeptOverride((o) => ({ ...o, [runId]: !keep }));
                      setError(errorMessage(err));
                    });
                  }}
                />
                보관(보관 기간이 지나도 증적을 지우지 않음)
              </label>
              {detail.evidenceRemoved ? (
                <p className="warning" data-testid="evidence-removed">
                  보관 기간이 지나 이 실행의 로컬 증적(캡처·로그)을 지웠습니다. 실행 기록과 올린 요약은 남아 있습니다.
                </p>
              ) : null}
              {detail.executions.length > 1 ? (
                <div className="row" role="tablist" aria-label="회차">
                  {detail.executions.map((e) => (
                    <button key={e.id} type="button" role="tab" aria-selected={e.id === executionId} className={e.id === executionId ? "" : "secondary"} onClick={() => setExecutionId(e.id)}>
                      {e.attempt}회차 · {RUN_STATUS[e.status === "skipped" ? "canceled" : e.status]}
                    </button>
                  ))}
                </div>
              ) : null}
              {execution?.failure ? (
                <p className="error" data-testid="results-failure">
                  {execution.failure.message}
                  {execution.failureClass ? ` (${FAILURE_CLASS[execution.failureClass] ?? execution.failureClass})` : ""}
                </p>
              ) : null}
              {execution?.warnings.map((w) => (
                <small key={w} className="warning">
                  {w}
                </small>
              ))}
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  disabled={provider === null || judging || claudeRunning || detail.status === "queued" || detail.status === "running"}
                  onClick={() => void judgeNow()}
                >
                  {judging ? "판정 중" : viaClaude ? "Claude 로 화면 판정" : "화면 판정"}
                </button>
                {claudeRunning && claudeJobId ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void window.qa.agent.cancelClaudeJudge({ jobId: claudeJobId }).then(setClaudeJudge, (e: unknown) => setJudgeMessage(errorMessage(e)))}
                  >
                    판정 취소
                  </button>
                ) : null}
                <small className="hint">
                  {viaClaude
                    ? "각자의 Claude 앱이 캡처를 판정합니다(Claude 요금제 한도). 결과는 배지로만 보입니다."
                    : "캡처를 LLM 으로 판정합니다(비용 발생). 결과는 배지로만 보입니다."}
                </small>
                {judgeMessage ? (
                  <small role="status" className="hint" data-testid="judge-message">
                    {judgeMessage}
                  </small>
                ) : null}
              </div>
              {claudeJudge?.claudeRequest ? (
                <ClaudeRequest
                  text={claudeJudge.claudeRequest}
                  testId="judge-claude-request"
                  hint={
                    claudeJudge.phase === "waiting_claude"
                      ? `Claude 데스크톱 앱이나 Claude Code 에 아래 요청을 붙여 넣습니다. 캡처 ${claudeJudge.total}장을 판정합니다.`
                      : `Claude${claudeJudge.claudeClient ? `(${claudeJudge.claudeClient})` : ""} 가 판정하고 있습니다: ${claudeJudge.judged}/${claudeJudge.total}`
                  }
                />
              ) : null}
              <ol className="timeline">
                {execution?.steps.map((s) => (
                  <li key={s.index}>
                    <button type="button" className={s.index === stepIndex ? "step-row selected" : "step-row"} data-testid={`step-${s.index}`} onClick={() => setStepIndex(s.index)}>
                      <span className={badge(s.status)}>{STEP_STATUS[s.status]}</span>
                      <code>{s.description}</code>
                      <span className="bar" style={{ width: `${Math.max(2, ((s.durationMs ?? 0) / maxDuration) * 100)}%` }} />
                      <small className="hint">{seconds(s.durationMs)}</small>
                      {s.failureScreenshot || s.screenshot ? <small aria-label="캡처 있음">📷</small> : null}
                      {judgementOf(s.index) ? (
                        <span className={judgementOf(s.index)?.verdict === "pass" ? "badge ok" : judgementOf(s.index)?.verdict === "fail" ? "badge bad" : "badge"} data-testid={`judge-${s.index}`}>
                          판정 {JUDGE_LABEL[judgementOf(s.index)?.verdict ?? "uncertain"]}
                        </span>
                      ) : null}
                    </button>
                    {s.error && s.index === stepIndex ? <div className="error">{s.error}</div> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <p className="hint">실행을 고르면 스텝, 캡처, 로그가 보입니다.</p>
          )}
          {detail && execution ? (
            <EvidenceUploadPanel
              runId={detail.id}
              executionId={execution.id}
              finished={detail.status !== "queued" && detail.status !== "running"}
              passed={detail.status === "passed"}
            />
          ) : null}

          {step ? (
            <section className="card stack" aria-label="스텝 증적">
              <h2>
                {step.index + 1}. <code>{step.description}</code>
              </h2>
              {capture?.kind === "image" ? (
                <img className="capture" data-testid="capture-img" src={capture.dataUrl} alt={`${step.description} 캡처`} />
              ) : (
                <p className="hint">{shotPath ? "캡처를 불러오는 중" : "이 스텝의 캡처가 없습니다."}</p>
              )}
              {shotPath ? <small className="hint">{fileName(shotPath)}</small> : null}
              {stepJudgement ? (
                <div className="stack" data-testid="judge-detail">
                  <small className="hint">
                    화면 판정: {JUDGE_LABEL[stepJudgement.verdict]}
                    {stepJudgement.confidence !== null ? ` · 확신도 ${Math.round(stepJudgement.confidence * 100)}%` : ""} · {stepJudgement.model} (실행 결과에는 반영하지 않음)
                  </small>
                  {stepJudgement.defects.map((d, i) => (
                    <small key={i} className="warning">
                      {d.type}: {d.description}
                    </small>
                  ))}
                  {stepJudgement.reason ? <small className="hint">{stepJudgement.reason}</small> : null}
                </div>
              ) : null}
              {step.hierarchy ? (
                <div className="stack">
                  <div className="row">
                    <button type="button" className="secondary" onClick={() => void showTree()}>
                      화면 트리
                    </button>
                    {tree ? <input aria-label="트리 필터" placeholder="텍스트·id 필터" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} /> : null}
                  </div>
                  {tree ? (
                    <ul className="tree" data-testid="hierarchy">
                      {tree.nodes
                        .filter((n) => !treeFilter || `${n.text} ${n.id}`.toLowerCase().includes(treeFilter.toLowerCase()))
                        .map((n, i) => (
                          <li key={i} style={{ paddingLeft: `${Math.min(n.depth, 30) * 8}px` }} className={n.enabled ? "" : "hint"}>
                            {n.text ? <span>{n.text}</span> : null} {n.id ? <code>#{n.id}</code> : null} <small className="hint">{n.bounds}</small>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {execution ? (
            <section className="card stack" aria-label="로그">
              <h2>로그</h2>
              <div className="row">
                <select aria-label="로그 파일" value={logPath ?? ""} onChange={(e) => (setFocusLine(null), setLogPath(e.target.value))}>
                  {logs.map((a) => (
                    <option key={a.path} value={a.path}>
                      {LOG_LABEL[a.kind] ?? a.kind} · {fileName(a.path)}
                    </option>
                  ))}
                </select>
                <form
                  className="row grow"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void search();
                  }}
                >
                  <input className="grow" aria-label="로그 검색" placeholder="모든 로그에서 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <button type="submit" className="secondary">
                    찾기
                  </button>
                </form>
              </div>
              {found ? (
                <ul className="matches" data-testid="log-matches">
                  {found.matches.length === 0 ? <li className="hint">찾지 못했습니다.</li> : null}
                  {found.matches.map((m) => (
                    <li key={`${m.path}:${m.line}`}>
                      <button type="button" className="link" onClick={() => openLine(m.path, m.line)}>
                        {fileName(m.path)}:{m.line}
                      </button>{" "}
                      <code>{m.text}</code>
                    </li>
                  ))}
                  {found.truncated ? <li className="hint">결과가 많아 일부만 보입니다.</li> : null}
                </ul>
              ) : null}
              {log?.kind === "text" ? (
                <div className="log" data-testid="log-view" ref={logBoxRef}>
                  {log.truncated ? <div className="hint">파일이 커서 끝부분만 보입니다({log.bytes.toLocaleString()}바이트).</div> : null}
                  {log.text.split("\n").map((line, i) => {
                    const n = log.firstLine + i;
                    return (
                      <div key={n} ref={n === focusLine ? focusRef : undefined} className={n === focusLine ? "log-line focus" : "log-line"} data-line={n}>
                        <span className="ln">{n}</span>
                        {line}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
