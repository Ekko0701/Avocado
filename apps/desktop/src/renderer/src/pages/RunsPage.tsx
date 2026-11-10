import type { RunDetail, RunSummary } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { RunSetup } from "../components/RunSetup";
import { errorMessage, formatDateTime } from "../lib/errors";

const RUN_STATUS: Record<RunSummary["status"], string> = {
  queued: "대기",
  running: "실행 중",
  passed: "통과",
  failed: "실패",
  error: "오류",
  canceled: "취소",
};
const STEP_STATUS: Record<string, string> = { completed: "완료", failed: "실패", warned: "경고", skipped: "건너뜀", pending: "대기", running: "실행 중" };
const FAILURE_CLASS: Record<string, string> = { env_issue: "환경 문제", flaky: "불안정(flaky)", app_bug: "앱 버그", test_drift: "테스트 어긋남", unknown: "미분류" };
const isActive = (r: RunSummary) => r.status === "queued" || r.status === "running";
const badgeClass = (s: RunSummary["status"]) => (s === "passed" ? "badge ok" : s === "failed" || s === "error" ? "badge bad" : "badge");
const seconds = (ms: number | null) => (ms === null ? "" : `${(ms / 1000).toFixed(1)}초`);

export function RunsPage(props: { onOpenResults?: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [openRun, setOpenRun] = useState<RunDetail | null>(null);
  /** 실행 기록을 읽거나 열거나 취소하다 난 오류 */
  const [message, setMessage] = useState<string | null>(null);

  const reloadRuns = useCallback(async () => {
    try {
      setRuns(await window.qa.runs.list());
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reloadRuns();
  }, [reloadRuns]);

  // 실행 중인 것이 있으면 2초마다 새로 읽는다
  const anyActive = runs?.some(isActive) ?? false;
  const openId = openRun?.id ?? null;
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => {
      void reloadRuns();
      if (openId) void window.qa.runs.get({ runId: openId }).then(setOpenRun, () => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [anyActive, openId, reloadRuns]);

  // 열어 둔 실행이 끝나면 마지막 상태로 한 번 더 읽는다(주기 갱신이 끝난 뒤에도 최종 결과가 보이게)
  useEffect(() => {
    if (!openRun || !isActive(openRun)) return;
    const latest = runs?.find((r) => r.id === openRun.id);
    if (latest && !isActive(latest)) void window.qa.runs.get({ runId: latest.id }).then(setOpenRun, () => undefined);
  }, [runs, openRun]);

  /** 실행을 시작한 뒤: 기록을 다시 읽고, 플로우 파일로 시작한 실행이면 그 스텝을 연다 */
  async function started(runId: string | null) {
    await reloadRuns();
    if (runId) await window.qa.runs.get({ runId }).then(setOpenRun, (e: unknown) => setMessage(errorMessage(e)));
  }

  async function open(runId: string) {
    try {
      setOpenRun(openRun?.id === runId ? null : await window.qa.runs.get({ runId }));
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  async function cancel(runId: string) {
    try {
      await window.qa.runs.cancel({ runId });
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      await reloadRuns();
    }
  }

  return (
    <>
      <h1>실행</h1>
      <RunSetup onStarted={(runId) => void started(runId)} />
      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}

      <section className="card stack" aria-label="실행 기록">
        <h2>실행 기록</h2>
        {runs === null ? <p>불러오는 중</p> : null}
        {runs && runs.length === 0 ? <p className="hint">실행 기록이 없습니다.</p> : null}
        <ul className="checks">
          {runs?.map((r) => (
            <li key={r.id} className="check" data-testid={`run-${r.id}`}>
              <span className={badgeClass(r.status)} data-testid="run-status">
                {RUN_STATUS[r.status]}
              </span>
              <div className="check-body">
                <strong>{r.flowName.includes(r.tcId) ? r.flowName : `${r.tcId} · ${r.flowName}`}</strong>
                <small className="hint">
                  {r.deviceName}
                  {r.buildLabel ? ` · ${r.buildLabel}` : ""} · {formatDateTime(r.createdAt)}
                  {r.attempts > 1 ? ` · ${r.attempts}회 실행` : ""}
                </small>
                {r.flaky ? <small className="warning">재시도에서 통과(불안정)</small> : null}
                {r.failureMessage ? <small className="error">{r.failureMessage}</small> : null}
              </div>
              <div className="row">
                {isActive(r) ? (
                  <button type="button" className="secondary" onClick={() => void cancel(r.id)}>
                    취소
                  </button>
                ) : null}
                <button type="button" className="secondary" onClick={() => void open(r.id)}>
                  {openRun?.id === r.id ? "접기" : "스텝"}
                </button>
                {props.onOpenResults && !isActive(r) ? (
                  <button type="button" className="secondary" onClick={() => props.onOpenResults?.(r.id)}>
                    결과
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {openRun ? (
        <section className="card stack" aria-label="실행 상세" data-testid="run-detail">
          <h2>
            {openRun.flowName} · {RUN_STATUS[openRun.status]}
          </h2>
          {openRun.executions.map((e) => (
            <div key={e.id} className="stack" data-testid={`execution-${e.attempt}`}>
              <strong>
                {e.attempt}회차 · {RUN_STATUS[e.status === "skipped" ? "canceled" : e.status]} {seconds(e.durationMs)}
                {e.failureClass ? ` · ${FAILURE_CLASS[e.failureClass] ?? e.failureClass}` : ""}
                {e.hostLoad !== null ? ` · 부하 ${e.hostLoad}` : ""}
              </strong>
              {e.failure ? <small className="error">{e.failure.message}</small> : null}
              {e.warnings.map((w) => (
                <small key={w} className="warning">
                  {w}
                </small>
              ))}
              <ol className="steps">
                {e.steps.map((s) => (
                  <li key={s.index} className={s.status === "failed" ? "step failed" : "step"}>
                    <span className="badge">{STEP_STATUS[s.status] ?? s.status}</span> <code>{s.description}</code> <small className="hint">{seconds(s.durationMs)}</small>
                    {s.error ? <div className="error">{s.error}</div> : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
