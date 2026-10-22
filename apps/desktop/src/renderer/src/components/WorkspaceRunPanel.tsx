import type { Build, Device, RunQueueStatus, TestcaseList } from "@qa/shared";
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "../lib/errors";

const TARGETS = ["ios", "android"] as const;

/** 워크스페이스의 TC 하나 또는 태그로 실행(PLAN 12장). 플로우 경로는 main 이 워크스페이스에서 찾는다 */
export function WorkspaceRunPanel(props: { builds: Build[]; devices: Device[]; onStarted: () => void }) {
  const [list, setList] = useState<TestcaseList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [app, setApp] = useState("");
  const [target, setTarget] = useState<(typeof TARGETS)[number]>("ios");
  const [tcId, setTcId] = useState("");
  const [tag, setTag] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [buildId, setBuildId] = useState("");
  const [queue, setQueue] = useState<RunQueueStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    window.qa.workspace.testcases().then(
      (l) => {
        setList(l);
        setApp((a) => a || l.apps[0]?.app || "");
      },
      (e: unknown) => setListError(errorMessage(e)),
    );
    void window.qa.runs.queue().then(setQueue, () => undefined);
  }, []);

  const busy = queue !== null && (queue.running !== null || queue.pending.length > 0);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void window.qa.runs.queue().then(setQueue, () => undefined), 2000);
    return () => clearInterval(timer);
  }, [busy]);

  // 앱·타깃을 바꾸면 그 앱·타깃 것이 아닌 선택을 지운다
  useEffect(() => {
    setBuildId("");
    setTcId("");
    setTag("");
    setDeviceId("");
  }, [app, target]);

  const runnable = useMemo(() => (list?.testcases ?? []).filter((t) => t.app === app && t.valid && t.flows.includes(target)), [list, app, target]);
  const tags = useMemo(() => [...new Set(runnable.filter((t) => t.status === "active").flatMap((t) => t.tags))].sort(), [runnable]);
  const tagCount = runnable.filter((t) => t.status === "active" && t.tags.includes(tag)).length;
  const devices = props.devices.filter((d) => d.platform === target);
  const builds = props.builds.filter((b) => b.app === app && b.target === target);
  const ready = app !== "" && devices.some((d) => d.id === deviceId) && !busy;

  async function start(by: { tcId: string } | { tag: string }) {
    setMessage(null);
    try {
      setQueue(await window.qa.runs.startFromWorkspace({ app, target, deviceId, buildId: buildId || null, ...by }));
      props.onStarted();
    } catch (e) {
      setMessage(`실행하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  if (listError) return <p className="hint">워크스페이스를 연결하면 TC·태그로 실행할 수 있습니다. ({listError})</p>;
  if (!list) return null;

  return (
    <section className="card stack" aria-label="워크스페이스에서 실행" data-testid="workspace-run">
      <h2>워크스페이스에서 실행</h2>
      <div className="grid">
        <label>
          앱
          <select aria-label="실행할 앱" value={app} onChange={(e) => setApp(e.target.value)}>
            {list.apps.map((a) => (
              <option key={a.app} value={a.app}>
                {a.name} ({a.app})
              </option>
            ))}
          </select>
        </label>
        <label>
          타깃
          <select aria-label="실행 타깃" value={target} onChange={(e) => setTarget(e.target.value as (typeof TARGETS)[number])}>
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          기기(실행 중)
          <select aria-label="실행 기기" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">선택</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          빌드(선택)
          <select aria-label="실행 빌드" value={buildId} onChange={(e) => setBuildId(e.target.value)}>
            <option value="">기기에 설치된 앱</option>
            {builds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.appId} {b.version} ({b.buildNumber})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <select aria-label="실행할 TC" value={tcId} onChange={(e) => setTcId(e.target.value)}>
          <option value="">TC 선택({runnable.length})</option>
          {runnable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} {t.title ?? ""}
            </option>
          ))}
        </select>
        <button type="button" disabled={!ready || !tcId} onClick={() => void start({ tcId })}>
          TC 실행
        </button>
        <select aria-label="실행할 태그" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">태그 선택</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="button" disabled={!ready || !tag} onClick={() => void start({ tag })}>
          태그로 차례 실행{tag ? ` (${tagCount}개)` : ""}
        </button>
      </div>
      {queue && (queue.running || queue.pending.length > 0 || queue.errors.length > 0) ? (
        <div className="row" data-testid="run-queue">
          <span className="hint">
            {queue.running ? "실행 중" : "대기"} · 남은 것: {queue.pending.length ? queue.pending.join(", ") : "없음"}
          </span>
          {busy ? (
            <button type="button" className="secondary" onClick={() => void window.qa.runs.clearQueue().then(setQueue, (e: unknown) => setMessage(errorMessage(e)))}>
              차례 실행 비우기
            </button>
          ) : null}
          {queue.errors.map((e) => (
            <small key={e} className="error">
              {e}
            </small>
          ))}
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="error">
          {message}
        </p>
      ) : null}
    </section>
  );
}
