import type { BuildActivity } from "@qa/shared";
import { useEffect, useRef, useState } from "react";
import { errorMessage, formatDateTime } from "../lib/errors";

const KIND_TEXT: Record<NonNullable<BuildActivity["running"]>["kind"], string> = { script: "빌드 스크립트", project: "프로젝트 빌드", prepare: "프로젝트 준비" };

const elapsed = (fromIso: string, to: number) => {
  const seconds = Math.max(0, Math.floor((to - Date.parse(fromIso)) / 1000));
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
};

/**
 * 진행 중인 빌드(단계·경과 시간·로그 끝부분·취소)와 마지막 결과. main 이 들고 있는 상태를 읽어서,
 * 화면을 떠났다 돌아와도 진행 중인 빌드가 보인다. 빌드 중에는 자주, 아닐 때는 가끔 다시 읽는다
 */
export function BuildActivityCard(props: { onRunningChange: (running: boolean) => void; onFinished: () => void }) {
  const [activity, setActivity] = useState<BuildActivity | null>(null);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const { onRunningChange, onFinished } = props;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const next = await window.qa.builds.activity().catch((e: unknown) => {
        setMessage(errorMessage(e));
        return null;
      });
      if (stopped) return;
      if (next) {
        setActivity(next);
        setNow(Date.now());
        const running = next.running !== null;
        if (running !== wasRunning.current) onRunningChange(running);
        if (wasRunning.current && !running) onFinished();
        wasRunning.current = running;
      }
      timer = setTimeout(() => void load(), next?.running ? 1500 : 5000);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [onRunningChange, onFinished]);

  async function cancel() {
    setMessage(null);
    try {
      setActivity(await window.qa.builds.cancel());
      setMessage("취소를 요청했습니다. 하위 프로세스를 끝내는 데 몇 초 걸릴 수 있습니다");
    } catch (e) {
      setMessage(`취소하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  const running = activity?.running ?? null;
  const last = activity?.last ?? null;
  if (!running && !last && !message) return null;

  return (
    <section className="card stack" aria-label="빌드 진행" data-testid="build-activity">
      {running ? (
        <>
          <div className="row">
            <h2>빌드 중</h2>
            <span className="badge ok">{elapsed(running.startedAt, now)}</span>
            <button type="button" className="secondary" onClick={() => void cancel()}>
              빌드 취소
            </button>
          </div>
          <p data-testid="build-activity-running">
            {running.app} · {KIND_TEXT[running.kind]} · {running.label}
            {running.step ? ` · 지금 단계: ${running.step}` : ""}
          </p>
          <pre className="log build-log" aria-label="빌드 로그" data-testid="build-activity-log">
            {running.log || "출력 기다리는 중"}
          </pre>
        </>
      ) : last ? (
        <>
          <h2>마지막 빌드: {last.ok ? "성공" : last.canceled ? "취소함" : "실패"}</h2>
          <p data-testid="build-activity-last">
            {last.app} · {KIND_TEXT[last.kind]} · {last.label} · {formatDateTime(last.finishedAt)} 에 끝남 ({elapsed(last.startedAt, Date.parse(last.finishedAt))})
          </p>
          {last.build ? (
            <p className="ok-text">
              등록했습니다: {last.build.appId} {last.build.version} ({last.build.buildNumber})
            </p>
          ) : null}
          {last.error ? (
            <p className={last.canceled ? "warning" : "error"} role="alert">
              {last.error}
            </p>
          ) : null}
          {last.log ? (
            <details open={!last.ok && !last.canceled}>
              <summary>로그 마지막 부분</summary>
              <pre className="log build-log" aria-label="빌드 로그">
                {last.log}
              </pre>
            </details>
          ) : null}
        </>
      ) : null}
      {message ? (
        <p role="status" className="hint">
          {message}
        </p>
      ) : null}
    </section>
  );
}
