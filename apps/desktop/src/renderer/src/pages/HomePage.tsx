import type { AppInfo, DbStatus, MyPullRequest, RunSummary, SetupCheck, SetupReport, WorkspaceStatus } from "@qa/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorMessage, formatDateTime } from "../lib/errors";
import { onWorkspaceChanged } from "../lib/workspace-events";

const RUN_STATUS: Record<RunSummary["status"], string> = { queued: "대기", running: "실행 중", passed: "통과", failed: "실패", error: "오류", canceled: "취소" };
/** 환경 점검은 xcodebuild·simctl 을 띄우므로 홈에 올 때마다 하지 않고 10분 동안 재사용한다 */
let setupCache: { at: number; report: Promise<SetupReport> } | null = null;
function cachedSetupCheck(): Promise<SetupReport> {
  if (!setupCache || Date.now() - setupCache.at > 10 * 60_000) {
    const report = window.qa.setup.check();
    setupCache = { at: Date.now(), report };
    report.catch(() => {
      setupCache = null;
    });
  }
  return setupCache.report;
}

const badge = (s: RunSummary["status"]) => (s === "passed" ? "badge ok" : s === "failed" || s === "error" ? "badge bad" : "badge");

/** 홈(PLAN 12장): 워크스페이스 동기화 상태, 최근 실행, 내 PR, 환경 경고. 아래에 앱 정보와 진단 */
export function HomePage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [db, setDb] = useState<DbStatus | null>(null);
  const [ws, setWs] = useState<WorkspaceStatus | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [pulls, setPulls] = useState<MyPullRequest[] | null>(null);
  const [pullsError, setPullsError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<SetupCheck[] | null>(null);
  const [message, setMessage] = useState("hello");
  const [pong, setPong] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 섹션마다 따로 채운다(느린 호출이 다른 섹션을 막지 않게)
  const load = useCallback(() => {
    window.qa.app.getInfo().then(setInfo, (e: unknown) => setError(errorMessage(e)));
    window.qa.db.status().then(setDb, () => undefined);
    window.qa.workspace.status().then(setWs, () => undefined);
    window.qa.runs.list().then((r) => setRuns(r.slice(0, 5)), () => undefined);
    window.qa.workspace.myPulls().then(setPulls, (e: unknown) => setPullsError(errorMessage(e)));
    cachedSetupCheck().then((r) => setWarnings(r.checks.filter((x) => x.status !== "ok")), () => undefined);
  }, []);

  useEffect(() => {
    load();
    // 툴바에서 동기화하면 다시 읽는다
    return onWorkspaceChanged(load);
  }, [load]);


  async function onPing(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await window.qa.app.ping({ message });
      setPong(result.message);
    } catch (e) {
      setPong(null);
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <h1>홈</h1>
      {warnings && warnings.length > 0 ? (
        <section className="card stack" aria-label="환경 경고" data-testid="home-warnings">
          <h2>환경 경고</h2>
          <ul className="checks">
            {warnings.map((w) => (
              <li key={w.id} className={w.required ? "error" : "warning"}>
                <strong>{w.label}</strong> {w.detail} {w.fix ? <small className="hint">· {w.fix}</small> : null}
              </li>
            ))}
          </ul>
          <small className="hint">설정 마법사에서 다시 점검하고 도구를 설치합니다.</small>
        </section>
      ) : null}

      <section className="card stack" aria-label="워크스페이스 상태" data-testid="home-workspace">
        <h2>워크스페이스</h2>
        {ws?.connected ? (
          <div className="row">
            <span>
              {ws.repo} · <strong>{ws.branch}</strong>
              {ws.behind > 0 ? ` · 원격보다 ${ws.behind}개 뒤` : ""}
              {ws.ahead > 0 ? ` · 올리지 않은 커밋 ${ws.ahead}개` : ""}
              {ws.dirty.length > 0 ? ` · 저장하지 않은 파일 ${ws.dirty.length}개` : ""}
              {ws.issues > 0 ? ` · 파일 문제 ${ws.issues}개` : ""}
            </span>
          </div>
        ) : (
          <p className="hint">{ws?.repo ? `${ws.repo} 를 아직 연결하지 않았습니다. 워크스페이스 메뉴에서 연결합니다.` : "설정에서 GitHub 조직을 정하면 워크스페이스를 연결할 수 있습니다."}</p>
        )}
      </section>

      <section className="card stack" aria-label="최근 실행" data-testid="home-runs">
        <h2>최근 실행</h2>
        {runs && runs.length > 0 ? (
          <ul className="checks">
            {runs.map((r) => (
              <li key={r.id}>
                <span className={badge(r.status)}>{RUN_STATUS[r.status]}</span> {r.tcId} {r.flowName} <small className="hint">{r.target} · {formatDateTime(r.createdAt)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">실행 기록이 없습니다.</p>
        )}
      </section>

      <section className="card stack" aria-label="내 PR" data-testid="home-pulls">
        <h2>내 PR</h2>
        {pulls && pulls.length > 0 ? (
          <ul className="checks">
            {pulls.map((p) => (
              <li key={p.number}>
                <button type="button" className="link" onClick={() => void window.qa.app.openExternal({ url: p.url }).catch((e: unknown) => setError(errorMessage(e)))}>
                  #{p.number} {p.title}
                </button>{" "}
                <small className="hint">{p.branch}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">
            {pulls ? "열린 PR 이 없습니다." : pullsError ? (ws?.connected ? `PR 을 불러오지 못했습니다: ${pullsError}` : "워크스페이스를 연결하면 내 PR 이 보입니다.") : "불러오는 중"}
          </p>
        )}
      </section>

      <section aria-label="앱 정보" className="card">
        {info ? (
          <dl>
            <dt>버전</dt>
            <dd data-testid="app-version">{info.version}</dd>
            <dt>Electron</dt>
            <dd data-testid="electron-version">{info.versions.electron}</dd>
            <dt>Node</dt>
            <dd>{info.versions.node}</dd>
            <dt>플랫폼</dt>
            <dd>
              {info.platform} / {info.arch}
            </dd>
            <dt>로컬 DB</dt>
            <dd data-testid="db-status">
              {db ? `스키마 v${db.schemaVersion}/${db.latestVersion} · ${db.journalMode} · 테이블 ${db.tables.length}개` : "확인 중"}
            </dd>
          </dl>
        ) : (
          <p>불러오는 중</p>
        )}
      </section>
      <form className="card row" onSubmit={onPing} aria-label="진단">
        <label className="grow">
          IPC 확인 메시지
          <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} />
        </label>
        <button type="submit">보내기</button>
        <output data-testid="pong">{pong}</output>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </>
  );
}
