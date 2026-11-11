import type { Build, Device, PickedFlow, RunQueueStatus, TestcaseList } from "@qa/shared";
import { AppIdSchema } from "@qa/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildLabel } from "../lib/build-label";
import { deviceLabel } from "../lib/device-label";
import { errorMessage } from "../lib/errors";

const TARGETS = ["ios", "android"] as const;
type Target = (typeof TARGETS)[number];
/** 실행할 것을 고르는 방법: 워크스페이스의 테스트 케이스 하나, 태그로 묶은 여럿, 워크스페이스 밖의 플로우 파일 하나 */
type Mode = "tc" | "tag" | "file";
const MODES: { id: Mode; label: string }[] = [
  { id: "tc", label: "테스트 케이스" },
  { id: "tag", label: "태그" },
  { id: "file", label: "플로우 파일" },
];

/**
 * 실행 준비: 실행할 것(테스트 케이스·태그·플로우 파일)과 실행할 곳(기기·빌드)을 한 카드에서 고른다(PLAN 12장).
 * 어느 방법이든 Maestro 플로우를 LLM 없이 재생한다. 테스트 케이스·태그는 main 이 워크스페이스에서 그 플로우를 찾고, 플로우 파일은 고른 파일을 그대로 쓴다.
 * 워크스페이스를 연결하지 않았으면 플로우 파일만 쓸 수 있다
 */
export function RunSetup(props: { onStarted: (runId: string | null) => void }) {
  const [list, setList] = useState<TestcaseList | null>(null);
  /** 워크스페이스 목록을 읽지 못한 이유(연결 전 등). 있으면 플로우 파일로만 실행한다 */
  const [listError, setListError] = useState<string | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [picked, setPicked] = useState<Mode>("tc");
  const [app, setApp] = useState("");
  const [target, setTarget] = useState<Target>("ios");
  const [tcId, setTcId] = useState("");
  const [tag, setTag] = useState("");
  const [flow, setFlow] = useState<PickedFlow | null>(null);
  const [appInput, setAppInput] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [buildId, setBuildId] = useState("");
  const [queue, setQueue] = useState<RunQueueStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const reloadTargets = useCallback(async () => {
    const [b, d] = await Promise.allSettled([window.qa.builds.list(), window.qa.devices.list()]);
    if (b.status === "fulfilled") setBuilds(b.value);
    if (d.status === "fulfilled") setDevices(d.value.devices.filter((x) => x.state === "booted"));
  }, []);

  useEffect(() => {
    window.qa.workspace.testcases().then(
      (l) => {
        setList(l);
        setApp((a) => a || l.apps[0]?.app || "");
      },
      (e: unknown) => setListError(errorMessage(e)),
    );
    void window.qa.runs.queue().then(setQueue, () => undefined);
    void reloadTargets();
  }, [reloadTargets]);

  const queueBusy = queue !== null && (queue.running !== null || queue.pending.length > 0);
  useEffect(() => {
    if (!queueBusy) return;
    const timer = setInterval(() => void window.qa.runs.queue().then(setQueue, () => undefined), 2000);
    return () => clearInterval(timer);
  }, [queueBusy]);

  const loaded = list !== null || listError !== null;
  const mode: Mode = list ? picked : "file";
  const fromWorkspace = mode !== "file";

  // 앱·타깃을 바꾸면 그 앱·타깃 것이 아닌 선택을 지운다
  useEffect(() => {
    setTcId("");
    setTag("");
  }, [app, target]);

  const runnable = useMemo(() => (list?.testcases ?? []).filter((t) => t.app === app && t.valid && t.flows.includes(target)), [list, app, target]);
  const tags = useMemo(() => [...new Set(runnable.filter((t) => t.status === "active").flatMap((t) => t.tags))].sort(), [runnable]);
  const tagged = runnable.filter((t) => t.status === "active" && t.tags.includes(tag));

  // 기기·빌드는 한 번만 고른다. 고를 수 있는 것은 방법에 따라 다르다: 워크스페이스는 그 앱·타깃 것, 플로우 파일은 전부(빌드를 고르면 그 타깃의 기기)
  const fileBuild = fromWorkspace ? null : (builds.find((b) => b.id === buildId) ?? null);
  const buildOptions = useMemo(() => (fromWorkspace ? builds.filter((b) => b.app === app && b.target === target) : builds), [fromWorkspace, builds, app, target]);
  const deviceOptions = useMemo(
    () => (fromWorkspace ? devices.filter((d) => d.platform === target) : devices.filter((d) => !fileBuild || d.platform === fileBuild.target)),
    [fromWorkspace, devices, target, fileBuild],
  );
  useEffect(() => {
    if (buildId && !buildOptions.some((b) => b.id === buildId)) setBuildId("");
  }, [buildId, buildOptions]);
  useEffect(() => {
    if (deviceId && !deviceOptions.some((d) => d.id === deviceId)) setDeviceId("");
  }, [deviceId, deviceOptions]);

  const device = deviceOptions.find((d) => d.id === deviceId) ?? null;
  const fileApp = fileBuild ? fileBuild.app : appInput;
  const canStart =
    device !== null &&
    !starting &&
    (mode === "tc" ? app !== "" && tcId !== "" && !queueBusy : mode === "tag" ? app !== "" && tag !== "" && !queueBusy : flow !== null && AppIdSchema.safeParse(fileApp).success);

  async function pickFlow() {
    setMessage(null);
    try {
      const file = await window.qa.runs.pickFlow();
      if (file) setFlow(file);
    } catch (e) {
      setMessage({ text: `플로우를 읽지 못했습니다: ${errorMessage(e)}`, error: true });
    }
  }

  async function start() {
    if (!device) return;
    setStarting(true);
    setMessage(null);
    try {
      if (mode === "file") {
        if (!flow) return;
        const run = await window.qa.runs.start({ app: fileApp, flowPath: flow.path, deviceId: device.id, buildId: fileBuild?.id ?? null });
        setMessage({ text: `실행을 시작했습니다: ${run.flowName}`, error: false });
        props.onStarted(run.id);
      } else {
        setQueue(await window.qa.runs.startFromWorkspace({ app, target, deviceId: device.id, buildId: buildId || null, ...(mode === "tc" ? { tcId } : { tag }) }));
        props.onStarted(null);
      }
    } catch (e) {
      setMessage({ text: `실행하지 못했습니다: ${errorMessage(e)}`, error: true });
      props.onStarted(null);
    } finally {
      setStarting(false);
    }
  }

  const action = starting ? "시작 중" : mode === "tc" ? "테스트 케이스 실행" : mode === "tag" ? `태그로 차례 실행${tag ? ` (${tagged.length}개)` : ""}` : "플로우 실행";

  return (
    <section className="card stack" aria-label="실행 준비" data-testid="run-setup">
      <div className="card-head">
        <h2>실행할 것</h2>
        <div className="row" role="tablist" aria-label="실행할 것을 고르는 방법">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={loaded && mode === m.id}
              className={loaded && mode === m.id ? "" : "secondary"}
              disabled={m.id !== "file" && !list}
              onClick={() => setPicked(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {!loaded ? <p className="hint">불러오는 중</p> : null}

      {loaded && fromWorkspace && list ? (
        <>
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
              <select aria-label="실행 타깃" value={target} onChange={(e) => setTarget(e.target.value as Target)}>
                {TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {mode === "tc" ? (
            <>
              <label>
                테스트 케이스
                <select aria-label="실행할 테스트 케이스" value={tcId} onChange={(e) => setTcId(e.target.value)}>
                  <option value="">선택</option>
                  {runnable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id} {t.title ?? ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint" data-testid="run-what-hint">
                {runnable.length > 0
                  ? `이 앱·타깃의 플로우가 있는 테스트 케이스 ${runnable.length}개 중에서 고릅니다.`
                  : "이 앱·타깃에는 플로우가 있는 테스트 케이스가 없습니다. 플로우 만들기에서 먼저 만듭니다."}
              </p>
            </>
          ) : (
            <>
              <label>
                태그
                <select aria-label="실행할 태그" value={tag} onChange={(e) => setTag(e.target.value)}>
                  <option value="">선택</option>
                  {tags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint" data-testid="run-what-hint">
                {tag ? (
                  <>
                    <code>{tag}</code> 태그가 붙은 테스트 케이스 {tagged.length}개를 차례로 실행합니다: {tagged.map((t) => t.id).join(", ")}
                  </>
                ) : tags.length > 0 ? (
                  "플로우가 있고 상태가 사용인 테스트 케이스의 태그 중에서 고릅니다."
                ) : (
                  "이 앱·타깃에는 태그로 실행할 테스트 케이스가 없습니다."
                )}
              </p>
            </>
          )}
        </>
      ) : null}

      {loaded && !fromWorkspace ? (
        <>
          <div className="row center">
            <button type="button" className="secondary" onClick={() => void pickFlow()}>
              플로우 파일 고르기
            </button>
            {flow ? (
              <span data-testid="picked-flow">
                <strong>{flow.name}</strong> <span className="badge">{flow.tcId}</span> <small className="hint">{flow.path}</small>
              </span>
            ) : (
              <span className="hint">고른 플로우 파일 없음</span>
            )}
          </div>
          {fileBuild ? (
            <p className="hint">
              앱 ID: <code>{fileBuild.app}</code> (고른 빌드의 앱)
            </p>
          ) : (
            <label>
              앱 ID
              <input aria-label="실행 앱 ID" value={appInput} onChange={(e) => setAppInput(e.target.value.trim())} placeholder="예: demo" />
            </label>
          )}
          <p className="hint" data-testid="run-what-hint">
            {list ? "워크스페이스에 없는 플로우 파일을 한 번 재생합니다. 빌드를 고르면 그 빌드의 앱을 씁니다." : "워크스페이스를 연결하면 테스트 케이스·태그로도 실행할 수 있습니다."}
          </p>
        </>
      ) : null}

      <hr className="rule" />
      <h2>실행할 곳</h2>
      <div className="grid">
        <label>
          기기(실행 중)
          <select aria-label="실행 기기" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">기기 선택</option>
            {deviceOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          빌드(선택)
          <select aria-label="실행 빌드" value={buildId} onChange={(e) => setBuildId(e.target.value)}>
            <option value="">기기에 설치된 앱</option>
            {buildOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {fromWorkspace ? buildLabel(b) : `${b.app} · ${b.target === "ios" ? "iOS" : "Android"} · ${b.appId} · ${buildLabel(b)}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {deviceOptions.length === 0 ? <p className="hint">실행 중인 기기가 없습니다. 기기 화면에서 먼저 준비합니다.</p> : null}

      <hr className="rule" />
      <div className="row center">
        <button type="button" disabled={!canStart} onClick={() => void start()}>
          {action}
        </button>
        <button type="button" className="secondary" onClick={() => void reloadTargets()}>
          빌드·기기 새로고침
        </button>
      </div>
      <p className="hint">승인된 Maestro 플로우를 LLM 없이 재생합니다. 실패하면 한 번 다시 실행하고, 증적은 비밀 값을 가린 사본으로 보여 줍니다.</p>

      {queue && (queue.running || queue.pending.length > 0 || queue.errors.length > 0) ? (
        <div className="row" data-testid="run-queue">
          <span className="hint">
            {queue.running ? "실행 중" : "대기"} · 남은 것: {queue.pending.length ? queue.pending.join(", ") : "없음"}
          </span>
          {queueBusy ? (
            <button type="button" className="secondary" onClick={() => void window.qa.runs.clearQueue().then(setQueue, (e: unknown) => setMessage({ text: errorMessage(e), error: true }))}>
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
        <p role={message.error ? "alert" : "status"} className={message.error ? "error" : undefined} data-testid="run-message">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
