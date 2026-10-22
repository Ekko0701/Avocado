import type { Build, Device, PickedFlow, RunDetail, RunSummary } from "@qa/shared";
import { AppIdSchema } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { WorkspaceRunPanel } from "../components/WorkspaceRunPanel";
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
  const [flow, setFlow] = useState<PickedFlow | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [buildId, setBuildId] = useState("");
  const [appInput, setAppInput] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [openRun, setOpenRun] = useState<RunDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadRuns = useCallback(async () => {
    try {
      setRuns(await window.qa.runs.list());
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }, []);

  const reloadTargets = useCallback(async () => {
    const [b, d] = await Promise.allSettled([window.qa.builds.list(), window.qa.devices.list()]);
    if (b.status === "fulfilled") setBuilds(b.value);
    if (d.status === "fulfilled") setDevices(d.value.devices.filter((x) => x.state === "booted"));
  }, []);

  useEffect(() => {
    void reloadRuns();
    void reloadTargets();
  }, [reloadRuns, reloadTargets]);

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

  const build = builds.find((b) => b.id === buildId) ?? null;
  const app = build ? build.app : appInput;
  const device = devices.find((d) => d.id === deviceId) ?? null;
  const usableDevices = devices.filter((d) => !build || d.platform === build.target);
  const appValid = AppIdSchema.safeParse(app).success;
  const canStart = flow !== null && device !== null && appValid && !busy;

  async function pickFlow() {
    setMessage(null);
    try {
      const picked = await window.qa.runs.pickFlow();
      if (picked) setFlow(picked);
    } catch (e) {
      setMessage(`플로우를 읽지 못했습니다: ${errorMessage(e)}`);
    }
  }

  async function start() {
    if (!flow || !device) return;
    setBusy(true);
    setMessage(null);
    try {
      const run = await window.qa.runs.start({ app, flowPath: flow.path, deviceId: device.id, buildId: build?.id ?? null });
      setMessage(`실행을 시작했습니다: ${run.flowName}`);
      setOpenRun(await window.qa.runs.get({ runId: run.id }));
    } catch (e) {
      setMessage(`실행하지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
      await reloadRuns();
    }
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
      <WorkspaceRunPanel builds={builds} devices={devices} onStarted={() => void reloadRuns()} />
      <section className="card stack" aria-label="실행 준비">
        <p className="hint">승인된 Maestro 플로우를 LLM 없이 재생합니다. 실패하면 한 번 다시 실행하고, 증적은 비밀 값을 가린 사본으로 보여 줍니다.</p>
        <div className="row">
          <button type="button" className="secondary" onClick={() => void pickFlow()}>
            플로우 선택
          </button>
          {flow ? (
            <span data-testid="picked-flow">
              <strong>{flow.name}</strong> <span className="badge">{flow.tcId}</span> <small className="hint">{flow.path}</small>
            </span>
          ) : (
            <span className="hint">선택한 플로우 없음</span>
          )}
        </div>
        <div className="grid">
          <label>
            빌드
            <select aria-label="빌드" value={buildId} onChange={(e) => setBuildId(e.target.value)}>
              <option value="">빌드 없이(기기에 설치된 앱)</option>
              {builds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.app} · {b.appId} {b.version} ({b.buildNumber}) · {b.target === "ios" ? "iOS" : "Android"}
                </option>
              ))}
            </select>
          </label>
          {build ? null : (
            <label>
              앱 ID
              <input aria-label="실행 앱 ID" value={appInput} onChange={(e) => setAppInput(e.target.value.trim())} placeholder="예: demo" />
            </label>
          )}
          <label>
            기기
            <select aria-label="실행 기기" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">기기 선택</option>
              {usableDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {usableDevices.length === 0 ? <p className="hint">실행 중인 기기가 없습니다. 기기 화면에서 먼저 준비합니다.</p> : null}
        <div className="row">
          <button type="button" disabled={!canStart} onClick={() => void start()}>
            {busy ? "시작 중" : "실행"}
          </button>
          <button type="button" className="secondary" onClick={() => void reloadTargets()}>
            빌드·기기 새로고침
          </button>
        </div>
        {message ? (
          <p role="status" data-testid="run-message">
            {message}
          </p>
        ) : null}
      </section>

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
