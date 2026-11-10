import type { QaJob, QaJobStage } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatDateTime } from "../lib/errors";

const STAGES: { id: QaJobStage; label: string }[] = [
  { id: "received", label: "접수" },
  { id: "analysis", label: "분석" },
  { id: "fix", label: "수정" },
  { id: "build", label: "빌드" },
  { id: "verify", label: "기기 확인" },
  { id: "mr", label: "MR" },
  { id: "done", label: "끝" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label])) as Record<QaJobStage, string>;
const STATUS: Record<QaJob["status"], { label: string; badge: string }> = {
  running: { label: "진행 중", badge: "badge" },
  succeeded: { label: "완료", badge: "badge ok" },
  failed: { label: "오류", badge: "badge bad" },
  stopped: { label: "사람 확인 필요", badge: "badge" },
};
const RUN_LABEL = { before: "수정 전", after: "수정 후", check: "확인" } as const;
const RUN_STATUS = { passed: "통과", failed: "실패", error: "오류", canceled: "취소" } as const;

/**
 * QA 수정 작업 모니터링(사이드 브랜치). Claude Code 가 MCP 로 알린 진행을 보여 주기만 한다.
 * 티켓·MR 주소는 글자로만 보인다. 앱은 허용 목록 밖의 주소를 열지 않는다.
 */
export function QaJobsPage(props: { onOpenResults: (runId: string) => void }) {
  const [jobs, setJobs] = useState<QaJob[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(() => {
    window.qa.qajobs.list().then(
      (list) => {
        setJobs(list);
        setMessage(null);
      },
      (e: unknown) => setMessage(errorMessage(e)),
    );
  }, []);

  // 진행 중인 작업이 계속 바뀌므로 화면이 열려 있는 동안 3초마다 다시 읽는다
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <>
      <h1>QA 작업</h1>
      <section className="card stack" aria-label="QA 작업 목록">
        <p className="hint">
          Claude Code 가 QA 티켓을 분석·수정·기기 확인·MR 까지 진행하는 동안 알려 온 내용입니다. 이 화면에서는 작업을 시작하거나 멈추지 않습니다.
        </p>
        {message ? <p className="error">{message}</p> : null}
        {jobs === null ? <p>불러오는 중</p> : null}
        {jobs && jobs.length === 0 ? <p className="hint">아직 알려 온 작업이 없습니다.</p> : null}
        <ul className="checks">
          {jobs?.map((job) => {
            const reached = STAGES.findIndex((s) => s.id === job.stage);
            const open = openId === job.id;
            return (
              <li key={job.id} className="check" data-testid={`qajob-${job.id}`}>
                <span className={STATUS[job.status].badge}>{STATUS[job.status].label}</span>
                <div className="check-body stack">
                  <strong>
                    {job.ticket} · {job.title}
                  </strong>
                  <div className="row" aria-label="진행 단계">
                    {STAGES.map((s, i) => (
                      <span key={s.id} className={i < reached ? "badge ok" : i === reached ? "badge" : "hint"} aria-current={i === reached ? "step" : undefined}>
                        {s.label}
                      </span>
                    ))}
                  </div>
                  <small className="hint">
                    {formatDateTime(job.updatedAt)}
                    {job.branch ? ` · ${job.branch}` : ""}
                  </small>
                  {job.events.length > 0 ? <small>{job.events.at(-1)?.message}</small> : null}
                  {job.runs.length > 0 ? (
                    <div className="row">
                      {job.runs.map((r) => (
                        <button key={r.runId} type="button" className="secondary" disabled={r.status === null} onClick={() => props.onOpenResults(r.runId)}>
                          {RUN_LABEL[r.label]} · {r.status ? RUN_STATUS[r.status] : "실행 중"} · {r.deviceName}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {open ? (
                    <div className="stack" data-testid="qajob-detail">
                      {job.url ? (
                        <small>
                          티켓 <code>{job.url}</code>
                        </small>
                      ) : null}
                      {job.mrUrl ? (
                        <small>
                          MR <code>{job.mrUrl}</code>
                        </small>
                      ) : null}
                      <ol className="steps">
                        {job.events.map((e, i) => (
                          <li key={`${e.at}-${i}`} className="step">
                            <span className="badge">{STAGE_LABEL[e.stage]}</span> {e.message} <small className="hint">{formatDateTime(e.at)}</small>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </div>
                <div className="row">
                  <button type="button" className="secondary" onClick={() => setOpenId(open ? null : job.id)}>
                    {open ? "접기" : "기록"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
