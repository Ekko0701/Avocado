import type { Build, Device } from "@qa/shared";
import { AppIdSchema } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { BuildActivityCard } from "../components/BuildActivityCard";
import { ProjectBuildPanel } from "../components/ProjectBuildPanel";
import { buildOrigin } from "../lib/build-label";
import { errorMessage, formatDateTime } from "../lib/errors";
import { deviceLabel } from "../lib/device-label";
import { useDevicePolling } from "../lib/use-device-polling";

const TARGET_TEXT: Record<Build["target"], string> = { ios: "iOS", android: "Android" };
const SOURCE_TEXT: Record<Build["source"], string> = { file: "파일", script: "스크립트", project: "프로젝트" };
const ADD_TABS = [
  { id: "file", label: "파일" },
  { id: "script", label: "스크립트" },
  { id: "project", label: "프로젝트" },
] as const;
type AddTab = (typeof ADD_TABS)[number]["id"];

/**
 * 빌드: 왼쪽은 등록한 빌드 목록(앱으로 거르기, 기기에 설치, 삭제), 오른쪽은 진행 중인 빌드와 빌드 더하기(파일 | 스크립트 | 프로젝트).
 */
export function BuildsPage() {
  const [tab, setTab] = useState<AddTab>("file");
  /** 목록을 거르는 앱. null 은 전체 */
  const [filter, setFilter] = useState<string | null>(null);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [app, setApp] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  /** main 에서 빌드가 진행 중이다(이 화면에서 시작하지 않았거나 화면을 떠났다 돌아온 경우도) */
  const [buildRunning, setBuildRunning] = useState(false);

  // 빌드 목록과 기기 목록은 따로 불러온다. 기기 조회가 실패해도 빌드 목록은 보여야 한다.
  // 기기를 꽂거나 빼면 새로고침 없이 기기 고르기에 반영한다(실행 중인·연결된 기기만)
  useDevicePolling((l) => setDevices(l.devices.filter((x) => x.state === "booted")));
  const reload = useCallback(async () => {
    const [list, deviceList] = await Promise.allSettled([window.qa.builds.list(), window.qa.devices.list()]);
    if (list.status === "fulfilled") setBuilds(list.value);
    if (deviceList.status === "fulfilled") setDevices(deviceList.value.devices.filter((d) => d.state === "booted"));
    const failed = [list, deviceList].flatMap((r) => (r.status === "rejected" ? [errorMessage(r.reason)] : []));
    setListError(failed.length > 0 ? failed.join(" / ") : null);
  }, []);

  useEffect(() => {
    void reload();
    // 워크스페이스 앱 목록으로 앱 ID 를 고르기 쉽게 한다(연결 전이면 직접 쓴다)
    window.qa.workspace.testcases().then(
      (l) => {
        setApps(l.apps.map((a) => a.app));
        setApp((current) => current || l.apps[0]?.app || "");
      },
      () => undefined,
    );
  }, [reload]);

  const appValid = AppIdSchema.safeParse(app).success;

  async function act(label: string, action: () => Promise<string | null>) {
    setBusy(label);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (e) {
      setMessage(`${label} 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
      await reload();
    }
  }

  const registered = (b: Build | null) => (b ? `등록했습니다: ${b.appId} ${b.version} (${b.buildNumber})` : null);

  const listApps = [...new Set((builds ?? []).map((b) => b.app))].sort();
  const shown = (builds ?? []).filter((b) => filter === null || !listApps.includes(filter) || b.app === filter);
  const locked = busy !== null || projectBusy || buildRunning || !appValid;

  return (
    <div className="split-page">
      <h1>빌드</h1>
      <div className="split-panes side-right builds-panes">
        <section className="card pane" aria-label="빌드 목록">
          <div className="pane-head">
            <div className="pane-head-title">
              <h2>등록한 빌드</h2>
              <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void reload()}>
                새로고침
              </button>
            </div>
            <small className="hint">실행·플로우 만들기에서 고를 수 있는 빌드입니다. 같은 버전이어도 덮어쓰지 않고 쌓입니다.</small>
          </div>
          <div className="pane-body">
            {message ? (
              <p role="status" data-testid="build-message">
                {message}
              </p>
            ) : null}
            {listError ? (
              <p className="error" role="alert">
                목록을 불러오지 못했습니다: {listError}
              </p>
            ) : null}
            {listApps.length > 1 ? (
              <div className="results-chips" aria-label="앱으로 거르기">
                <button type="button" className={filter === null ? "" : "secondary"} aria-pressed={filter === null} onClick={() => setFilter(null)}>
                  전체 {builds?.length ?? 0}
                </button>
                {listApps.map((a) => (
                  <button key={a} type="button" className={filter === a ? "" : "secondary"} aria-pressed={filter === a} onClick={() => setFilter(a)}>
                    {a} {builds?.filter((b) => b.app === a).length ?? 0}
                  </button>
                ))}
              </div>
            ) : null}
            {builds === null ? <p>불러오는 중</p> : null}
            {builds && builds.length === 0 ? <p className="hint">등록한 빌드가 없습니다.</p> : null}
            <ul className="checks">
              {shown.map((b) => (
                <BuildRow
                  key={b.id}
                  build={b}
                  devices={devices.filter((d) => d.platform === b.target)}
                  disabled={busy !== null || projectBusy}
                  onInstall={(deviceId, deviceName) =>
                    void act("설치", async () => {
                      const r = await window.qa.builds.install({ buildId: b.id, deviceId });
                      return r.installed ? `${deviceName} 에 설치했습니다: ${r.appId}` : `설치 명령은 끝났지만 ${deviceName} 에서 ${r.appId} 를 찾지 못했습니다`;
                    })
                  }
                  onRemove={() =>
                    void act("삭제", async () => {
                      setBuilds(await window.qa.builds.remove({ buildId: b.id }));
                      return `지웠습니다: ${b.appId} ${b.version} (${b.buildNumber}) · ${buildOrigin(b)}`;
                    })
                  }
                />
              ))}
            </ul>
          </div>
        </section>

        <div className="builds-side">
          <BuildActivityCard onRunningChange={setBuildRunning} onFinished={reload} />
          <section className="card pane" aria-label="빌드 더하기">
            <div className="pane-head">
              <h2>빌드 더하기</h2>
              <small className="hint">어느 앱의 빌드인지 정하고 방법을 고릅니다.</small>
            </div>
            <div className="pane-body">
              <label>
                앱 ID
                <input value={app} onChange={(e) => setApp(e.target.value.trim())} placeholder="예: demo" aria-invalid={app !== "" && !appValid} list="build-apps" />
                <datalist id="build-apps">
                  {apps.map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
              </label>
              {app !== "" && !appValid ? <p className="error">소문자·숫자·하이픈만, 40자 이하</p> : null}
              <div role="tablist" aria-label="빌드를 더하는 방법">
                {ADD_TABS.map((t) => (
                  <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
              {tab === "file" ? <p className="hint">iOS 시뮬레이터용 .app 또는 Android .apk 를 골라 등록합니다. .apk 는 에뮬레이터와 USB 로 연결한 Android 폰에 설치할 수 있습니다.</p> : null}
              {tab === "script" ? (
                <p className="hint">빌드 스크립트를 고르면 실행한 뒤, 스크립트가 QA_BUILD_INFO 파일에 적은 ARTIFACT 경로를 등록합니다. 수십 분 걸릴 수 있고, 진행은 위에 보입니다.</p>
              ) : null}
              {tab === "project" ? (
                appValid ? (
                  <ProjectBuildPanel app={app} disabled={busy !== null || buildRunning} onBusy={setProjectBusy} onBuilt={() => void reload()} />
                ) : (
                  <p className="hint">앱 ID 를 먼저 넣습니다.</p>
                )
              ) : null}
            </div>
            {tab !== "project" ? (
              <div className="pane-foot">
                {tab === "file" ? (
                  <button type="button" disabled={locked} onClick={() => void act("등록", async () => registered(await window.qa.builds.pickAndRegister({ app })))}>
                    {busy === "등록" ? "등록 중" : "파일로 등록"}
                  </button>
                ) : (
                  <button type="button" disabled={locked} onClick={() => void act("빌드", async () => registered(await window.qa.builds.runScript({ app })))}>
                    {busy === "빌드" ? "빌드 중" : "빌드 스크립트 실행"}
                  </button>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function BuildRow(props: { build: Build; devices: Device[]; disabled: boolean; onInstall: (deviceId: string, deviceName: string) => void; onRemove: () => void }) {
  const { build: b, devices } = props;
  const [deviceId, setDeviceId] = useState("");
  /** 지우기는 되돌릴 수 없어 한 번 더 확인한다 */
  const [confirming, setConfirming] = useState(false);
  const selected = devices.find((d) => d.id === deviceId) ?? devices[0];
  return (
    <li className="check build-row" data-testid={`build-${b.id}`}>
      <span className="badge">{TARGET_TEXT[b.target]}</span>
      <div className="check-body">
        <strong>
          {b.app} · {b.appId} {b.version} ({b.buildNumber})
        </strong>
        <small className="hint">
          {SOURCE_TEXT[b.source]}
          {b.label ? ` · ${b.label}` : ""}
          {b.commit ? ` · ${b.commit.slice(0, 10)}` : ""} · {formatDateTime(b.createdAt)}
        </small>
      </div>
      <div className="row center">
        {devices.length > 0 ? (
          <>
            <select aria-label="설치할 기기" value={selected?.id ?? ""} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {deviceLabel(d)}
                </option>
              ))}
            </select>
            <button type="button" disabled={props.disabled || !selected} onClick={() => selected && props.onInstall(selected.id, selected.name)}>
              설치
            </button>
          </>
        ) : (
          <small className="hint">실행 중인 {TARGET_TEXT[b.target]} 기기 없음</small>
        )}
        {confirming ? (
          <>
            <button type="button" className="danger" disabled={props.disabled} onClick={props.onRemove}>
              정말 삭제
            </button>
            <button type="button" className="secondary" disabled={props.disabled} onClick={() => setConfirming(false)}>
              취소
            </button>
          </>
        ) : (
          <button type="button" className="secondary" disabled={props.disabled} aria-label={`빌드 삭제: ${b.appId} ${b.version} (${b.buildNumber}) · ${buildOrigin(b)}`} onClick={() => setConfirming(true)}>
            삭제
          </button>
        )}
      </div>
    </li>
  );
}
