import type { AgentProvider, ClaudeJudgeJob, EvidenceArtifact, EvidenceFile, EvidenceSearchResult, Execution, HierarchyView, Judgement, RunDetail, RunStep, RunSummary } from "@qa/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClaudeRequest } from "../components/ClaudeRequest";
import { EvidenceUploadPanel } from "../components/EvidenceUploadPanel";
import { CaptureStrip } from "../components/CaptureStrip";
import { shortDateTime } from "../lib/dashboard";
import { errorMessage, formatDateTime } from "../lib/errors";
import { durationText, filterCounts, filterRuns, latestMatrix, runTitle, TARGET_LABEL, type RunFilter } from "../lib/results";

const RUN_STATUS: Record<RunSummary["status"], string> = { queued: "대기", running: "실행 중", passed: "통과", failed: "실패", error: "오류", canceled: "취소" };
const JUDGE_LABEL: Record<Judgement["verdict"], string> = { pass: "정상", fail: "결함", uncertain: "불확실" };
const STEP_STATUS: Record<RunStep["status"], string> = { completed: "완료", failed: "실패", warned: "경고", skipped: "건너뜀", pending: "대기", running: "실행 중" };
const FAILURE_CLASS: Record<string, string> = { env_issue: "환경 문제", flaky: "불안정", app_bug: "앱 버그", test_drift: "테스트 어긋남", unknown: "미분류" };
const LOG_KINDS: EvidenceArtifact["kind"][] = ["maestro_log", "console_log", "device_log", "runner_log", "junit"];
const LOG_LABEL: Record<string, string> = { maestro_log: "Maestro 로그", console_log: "콘솔", device_log: "기기 로그", runner_log: "드라이버 로그", junit: "JUnit" };
const FILTERS: { id: RunFilter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "failed", label: "실패" },
  { id: "passed", label: "통과" },
];
/** 로그를 열 때 처음 보여 줄 줄(실패 흔적) */
const FAILURE_LINE = /FAILED|Element not found|Assertion is false|Exception|Error:/;

type EvidenceTab = "log" | "tree" | "captures" | "upload";

const badge = (s: string) => (s === "passed" || s === "completed" ? "badge ok" : s === "failed" || s === "error" ? "badge bad" : "badge");
const verdictBadge = (v: Judgement["verdict"]) => (v === "pass" ? "badge ok" : v === "fail" ? "badge bad" : "badge");
const fileName = (p: string) => p.split("/").pop() ?? p;
const isFinished = (s: RunSummary["status"]) => s !== "queued" && s !== "running";

/** 실패한 실행이면 실패 스텝, 아니면 마지막 캡처가 있는 스텝 */
function defaultStep(e: Execution | undefined): number | null {
  if (!e) return null;
  if (e.failure?.stepIndex != null) return e.failure.stepIndex;
  const withShot = [...e.steps].reverse().find((s) => s.failureScreenshot || s.screenshot);
  return withShot?.index ?? e.steps[0]?.index ?? null;
}

/**
 * 결과: 왼쪽은 실행 목록(또는 테스트 케이스 × 타깃 표), 오른쪽은 고른 실행의 스텝·캡처와 증적 탭(로그·화면 트리·캡처 모아 보기·올리기).
 * 칸마다 따로 스크롤하고 페이지는 창 높이에 맞춘다
 */
export function ResultsPage(props: { initialRunId?: string | null; onOpenRuns?: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runId, setRunId] = useState<string | null>(props.initialRunId ?? null);
  const [listTab, setListTab] = useState<"runs" | "matrix">("runs");
  const [filter, setFilter] = useState<RunFilter>("all");
  const [runQuery, setRunQuery] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<EvidenceArtifact[]>([]);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [capture, setCapture] = useState<EvidenceFile | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("log");
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
  /** 증적 올리기 정책(D11). 꺼져 있으면 올리기 탭이 없다 */
  const [uploadApproved, setUploadApproved] = useState(false);
  /** Claude 앱 방식 화면 판정 작업(ADR 0022) */
  const [claudeJudge, setClaudeJudge] = useState<ClaudeJudgeJob | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // 처음 열 때 고른 실행이 없으면 가장 최근 실행을 연다
  useEffect(() => {
    window.qa.runs.list().then(
      (list) => {
        setRuns(list);
        setRunId((id) => id ?? list[0]?.id ?? null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
    window.qa.settings.get().then(
      (s) => {
        setProvider(s.settings.agent.provider);
        setUploadApproved(s.settings.policy.evidenceUploadApproved);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
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

  // 회차를 바꾸면 산출물 목록, 기본 스텝, 기본 로그(Maestro 로그)를 다시 연다.
  // 실행을 바꾼 직후에는 회차가 아직 이전 실행의 것이다. 고른 실행의 회차일 때만 증적을 찾는다
  useEffect(() => {
    if (!runId || !executionId) return;
    if (detail?.id !== runId || !detail.executions.some((e) => e.id === executionId)) return;
    let stale = false;
    setCapture(null);
    setTree(null);
    setLog(null);
    setFound(null);
    setStepIndex(defaultStep(detail.executions.find((e) => e.id === executionId)));
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

  const shots = execution?.steps.filter((s) => s.failureScreenshot || s.screenshot).length ?? 0;
  const canUpload = uploadApproved && detail !== null && isFinished(detail.status);
  // 고른 탭이 이 실행에 없으면(캡처가 없거나 올릴 수 없는 실행) 로그를 보인다
  const tab: EvidenceTab = (evidenceTab === "captures" && shots === 0) || (evidenceTab === "upload" && !canUpload) ? "log" : evidenceTab;

  // 화면 트리 탭을 보고 있으면 고른 스텝의 트리를 읽는다
  const hierarchyPath = step?.hierarchy ?? null;
  useEffect(() => {
    setTree(null);
    if (tab !== "tree" || !runId || !executionId || !hierarchyPath) return;
    let stale = false;
    window.qa.evidence.hierarchy({ runId, executionId, path: hierarchyPath }).then(
      (t) => !stale && setTree(t),
      (e: unknown) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [tab, runId, executionId, hierarchyPath]);

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

  // 로그 상자 안에서만 스크롤한다(칸 전체가 움직이면 스텝·캡처가 화면 밖으로 밀린다)
  const scrollLogToFocus = () => {
    const box = logBoxRef.current;
    const line = focusRef.current;
    if (box && line) box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 2);
  };
  useEffect(scrollLogToFocus, [log, focusLine, tab]);

  const matrix = useMemo(() => latestMatrix(runs ?? []), [runs]);
  const counts = useMemo(() => filterCounts(runs ?? []), [runs]);
  const shown = useMemo(() => filterRuns(runs ?? [], filter, runQuery), [runs, filter, runQuery]);
  const logs = artifacts.filter((a) => LOG_KINDS.includes(a.kind));

  async function search() {
    if (!runId || !executionId || !query.trim()) return;
    try {
      setFound(await window.qa.evidence.search({ runId, executionId, query: query.trim() }));
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
    // 이미 연 실행이면 그대로 둔다(로그의 실패 줄 위치를 지우지 않는다)
    if (id === runId) return;
    setError(null);
    setFocusLine(null);
    // 이전 실행의 회차와 로그 경로를 비운다. 새 실행의 회차 목록을 받으면 마지막 회차를 고르고 그 로그를 연다
    setExecutionId(null);
    setLogPath(null);
    setRunId(id);
  };

  const alert = error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;

  if (runs !== null && runs.length === 0) {
    return (
      <div className="results-page">
        <h1>결과</h1>
        {alert}
        <div className="results-panes">
          <section className="card results-list-pane" aria-label="실행">
            <p className="hint">실행 기록이 없습니다.</p>
          </section>
          <section className="card results-empty" aria-label="실행 상세">
            <strong>아직 실행 기록이 없습니다</strong>
            <p className="hint">실행 화면에서 테스트 케이스를 재생하면 결과가 여기에 쌓입니다.</p>
            {props.onOpenRuns ? (
              <button type="button" className="secondary" onClick={props.onOpenRuns}>
                실행 열기
              </button>
            ) : null}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="results-page">
      <h1>결과</h1>
      {alert}
      <div className="results-panes">
        <section className="card results-list-pane" aria-label="실행">
          <div role="tablist" aria-label="결과를 보는 방법">
            <button type="button" role="tab" aria-selected={listTab === "runs"} onClick={() => setListTab("runs")}>
              실행
            </button>
            <button type="button" role="tab" aria-selected={listTab === "matrix"} onClick={() => setListTab("matrix")}>
              테스트 케이스
            </button>
          </div>
          {listTab === "runs" ? (
            <>
              <input aria-label="실행 검색" placeholder="테스트 케이스·기기 검색" value={runQuery} onChange={(e) => setRunQuery(e.target.value)} />
              <div className="results-chips" aria-label="상태로 거르기">
                {FILTERS.map((f) => (
                  <button key={f.id} type="button" className={filter === f.id ? "" : "secondary"} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                    {f.label} {counts[f.id]}
                  </button>
                ))}
              </div>
              <div className="results-run-list" aria-label="실행 목록">
                {shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={r.id === runId ? "run-item selected" : "run-item"}
                    data-testid={`results-run-${r.id}`}
                    onClick={() => pick(r.id)}
                  >
                    <span className={badge(r.status)}>{RUN_STATUS[r.status]}</span>
                    <span className="run-item-body" title={`${runTitle(r)} · ${r.deviceName}`}>
                      <strong>{runTitle(r)}</strong>
                      <small className="hint">
                        {shortDateTime(r.createdAt)} · {TARGET_LABEL[r.target]}
                        {r.attempts > 1 ? ` · ${r.attempts}회` : ""} · {r.deviceName}
                      </small>
                    </span>
                  </button>
                ))}
                {runs !== null && shown.length === 0 ? <p className="hint">맞는 실행이 없습니다.</p> : null}
              </div>
              {runs !== null ? <p className="hint results-list-foot">{shown.length === runs.length ? `최근 실행 ${runs.length}건` : `${runs.length}건 가운데 ${shown.length}건`}</p> : null}
            </>
          ) : (
            <div className="results-matrix" aria-label="테스트 케이스별 최신 결과">
              <p className="hint">테스트 케이스·타깃마다 마지막 결과입니다. 칸을 누르면 그 실행을 엽니다.</p>
              <table className="matrix">
                <thead>
                  <tr>
                    <th>테스트 케이스</th>
                    <th>iOS</th>
                    <th>Android</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((row) => (
                    <tr key={row.tcId}>
                      <td>
                        <strong>{row.tcId}</strong>
                        <br />
                        <small className="hint">{row.title}</small>
                      </td>
                      {(["ios", "android"] as const).map((t) => {
                        const r = row[t];
                        return (
                          <td key={t}>
                            {r ? (
                              <button
                                type="button"
                                className={`${badge(r.status)} cell${r.id === runId ? " selected" : ""}`}
                                data-testid={`tc-cell-${row.tcId}-${t}`}
                                aria-label={`${row.tcId} ${TARGET_LABEL[t]} ${RUN_STATUS[r.status]}`}
                                onClick={() => pick(r.id)}
                              >
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
            </div>
          )}
        </section>

        {detail ? (
          <section className="card results-detail" aria-label="실행 상세" data-testid="results-detail">
            <div className="results-detail-head">
              <div className="results-detail-title">
                <h2>
                  {runTitle(detail)} <span className={badge(detail.status)}>{RUN_STATUS[detail.status]}</span>
                  {detail.flaky ? <span className="badge"> 불안정</span> : null}
                </h2>
                {detail.executions.length > 1 ? (
                  <div role="tablist" aria-label="회차">
                    {detail.executions.map((e) => (
                      <button key={e.id} type="button" role="tab" aria-selected={e.id === executionId} onClick={() => setExecutionId(e.id)}>
                        {e.attempt}회차 · {RUN_STATUS[e.status === "skipped" ? "canceled" : e.status]}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="secondary small"
                  title={
                    viaClaude
                      ? "각자의 Claude 앱이 캡처를 판정합니다(Claude 요금제 한도). 결과는 배지로만 보입니다."
                      : "캡처를 LLM 으로 판정합니다(비용 발생). 결과는 배지로만 보입니다."
                  }
                  disabled={provider === null || judging || claudeRunning || !isFinished(detail.status)}
                  onClick={() => void judgeNow()}
                >
                  {judging ? "판정 중" : viaClaude ? "Claude 로 화면 판정" : "화면 판정"}
                </button>
                {claudeRunning && claudeJobId ? (
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => void window.qa.agent.cancelClaudeJudge({ jobId: claudeJobId }).then(setClaudeJudge, (e: unknown) => setJudgeMessage(errorMessage(e)))}
                  >
                    판정 취소
                  </button>
                ) : null}
                <label className="check" title="보관 기간이 지나도 이 실행의 증적을 지우지 않습니다">
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
                  보관
                </label>
              </div>
              <small className="hint">
                {TARGET_LABEL[detail.target]} · {detail.deviceName}
                {detail.buildLabel ? ` · ${detail.buildLabel}` : ""} · {formatDateTime(detail.createdAt)}
                {execution?.durationMs != null ? ` · ${durationText(execution.durationMs)}` : ""}
                {viaClaude ? "" : " · 화면 판정은 LLM 비용이 듭니다"}
              </small>
              {execution?.failure ? (
                <p className="error" data-testid="results-failure">
                  {execution.failure.stepIndex != null ? `${execution.failure.stepIndex + 1}번째 스텝에서 실패: ` : ""}
                  {execution.failure.message}
                  {execution.failureClass ? ` (${FAILURE_CLASS[execution.failureClass] ?? execution.failureClass})` : ""}
                </p>
              ) : null}
              {execution?.warnings.map((w) => (
                <small key={w} className="warning">
                  {w}
                </small>
              ))}
              {detail.evidenceRemoved ? (
                <p className="warning" data-testid="evidence-removed">
                  보관 기간이 지나 이 실행의 로컬 증적(캡처·로그)을 지웠습니다. 실행 기록과 올린 요약은 남아 있습니다.
                </p>
              ) : null}
              {judgeMessage ? (
                <small role="status" className="hint" data-testid="judge-message">
                  {judgeMessage}
                </small>
              ) : null}
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
            </div>

            <div className="results-detail-body">
              <div className="results-step-capture">
                <div className="results-steps" aria-label="스텝 타임라인">
                  <strong className="results-label">스텝</strong>
                  <ol className="timeline">
                    {execution?.steps.map((s) => {
                      const j = judgementOf(s.index);
                      return (
                        <li key={s.index}>
                          <button type="button" className={s.index === stepIndex ? "step-row selected" : "step-row"} data-testid={`step-${s.index}`} title={s.description} onClick={() => setStepIndex(s.index)}>
                            <span className={badge(s.status)}>{STEP_STATUS[s.status]}</span>
                            <code>{s.description}</code>
                            <small className="hint">{durationText(s.durationMs)}</small>
                            {s.failureScreenshot || s.screenshot ? <small aria-label="캡처 있음">📷</small> : <span />}
                            {j ? (
                              <span className={verdictBadge(j.verdict)} data-testid={`judge-${s.index}`}>
                                판정 {JUDGE_LABEL[j.verdict]}
                              </span>
                            ) : null}
                          </button>
                          {s.error && s.index === stepIndex ? <div className="error">{s.error}</div> : null}
                        </li>
                      );
                    })}
                  </ol>
                </div>
                {step ? (
                  <figure className="results-capture" aria-label="스텝 캡처">
                    <strong className="results-label">
                      {step.index + 1}. {step.failureScreenshot ? "실패 캡처" : step.description}
                    </strong>
                    {capture?.kind === "image" ? (
                      <img className="capture" data-testid="capture-img" src={capture.dataUrl} alt={`${step.description} 캡처`} />
                    ) : (
                      <p className="hint">{shotPath ? "캡처를 불러오는 중" : "이 스텝의 캡처가 없습니다."}</p>
                    )}
                    {shotPath ? <figcaption className="hint">{fileName(shotPath)}</figcaption> : null}
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
                  </figure>
                ) : null}
              </div>

              {execution ? (
                <div className="results-evidence">
                  <div role="tablist" aria-label="증적">
                    <button type="button" role="tab" aria-selected={tab === "log"} onClick={() => setEvidenceTab("log")}>
                      로그
                    </button>
                    <button type="button" role="tab" aria-selected={tab === "tree"} onClick={() => setEvidenceTab("tree")}>
                      화면 트리
                    </button>
                    {shots > 0 ? (
                      <button type="button" role="tab" aria-selected={tab === "captures"} onClick={() => setEvidenceTab("captures")}>
                        캡처 {shots}장
                      </button>
                    ) : null}
                    {canUpload ? (
                      <button type="button" role="tab" aria-selected={tab === "upload"} onClick={() => setEvidenceTab("upload")}>
                        증적 올리기
                      </button>
                    ) : null}
                  </div>

                  {tab === "log" ? (
                    <>
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
                      ) : logs.length === 0 ? (
                        <p className="hint">이 회차의 로그가 없습니다.</p>
                      ) : null}
                      {log?.kind === "text" && focusLine !== null ? <small className="hint">{focusLine}번 줄로 옮겨 두었습니다.</small> : null}
                    </>
                  ) : null}

                  {tab === "tree" ? (
                    step?.hierarchy ? (
                      <>
                        <input aria-label="트리 필터" placeholder="텍스트·id 필터" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} />
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
                        ) : (
                          <p className="hint">화면 트리를 불러오는 중</p>
                        )}
                      </>
                    ) : (
                      <p className="hint">{step ? `${step.index + 1}번 스텝의 화면 트리가 없습니다.` : "스텝을 고르면 그 화면의 트리가 보입니다."}</p>
                    )
                  ) : null}

                  {tab === "captures" && detail ? <CaptureStrip runId={detail.id} executionId={execution.id} steps={execution.steps} selected={stepIndex} onSelect={setStepIndex} /> : null}

                  {tab === "upload" ? <EvidenceUploadPanel runId={detail.id} executionId={execution.id} finished={isFinished(detail.status)} passed={detail.status === "passed"} /> : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="card results-empty" aria-label="실행 상세">
            <p className="hint">{runs === null ? "불러오는 중" : "실행을 고르면 스텝, 캡처, 로그가 보입니다."}</p>
          </section>
        )}
      </div>
    </div>
  );
}
