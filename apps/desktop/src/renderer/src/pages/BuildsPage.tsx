import type { Build, Device } from "@qa/shared";
import { AppIdSchema } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { BuildActivityCard } from "../components/BuildActivityCard";
import { ProjectBuildPanel } from "../components/ProjectBuildPanel";
import { errorMessage, formatDateTime } from "../lib/errors";

const TARGET_TEXT: Record<Build["target"], string> = { ios: "iOS", android: "Android" };
const SOURCE_TEXT: Record<Build["source"], string> = { file: "파일", script: "스크립트", project: "프로젝트" };

export function BuildsPage() {
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

  return (
    <>
      <h1>빌드</h1>
      <BuildActivityCard onRunningChange={setBuildRunning} onFinished={reload} />
      <section className="card stack" aria-label="빌드 등록">
        <p className="hint">
          시뮬레이터용 .app 또는 .apk 를 등록합니다. 빌드 스크립트를 고르면 실행한 뒤, 스크립트가 QA_BUILD_INFO 파일에 적은 ARTIFACT 경로를 등록합니다.
        </p>
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
        <div className="row">
          <button type="button" disabled={busy !== null || projectBusy || buildRunning || !appValid} onClick={() => void act("등록", async () => registered(await window.qa.builds.pickAndRegister({ app })))}>
            {busy === "등록" ? "등록 중" : "파일로 등록"}
          </button>
          <button type="button" disabled={busy !== null || projectBusy || buildRunning || !appValid} onClick={() => void act("빌드", async () => registered(await window.qa.builds.runScript({ app })))}>
            {busy === "빌드" ? "빌드 중 (수십 분 걸릴 수 있음)" : "빌드 스크립트 실행"}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void reload()}>
            새로고침
          </button>
        </div>
        {message ? (
          <p role="status" data-testid="build-message">
            {message}
          </p>
        ) : null}
      </section>
      {appValid ? (
        <ProjectBuildPanel
          app={app}
          disabled={busy !== null || buildRunning}
          onBusy={setProjectBusy}
          onBuilt={() => void reload()}
        />
      ) : null}
      <section className="card stack" aria-label="빌드 목록">
        {listError ? (
          <p className="error" role="alert">
            목록을 불러오지 못했습니다: {listError}
          </p>
        ) : null}
        {builds === null ? <p>불러오는 중</p> : null}
        {builds && builds.length === 0 ? <p className="hint">등록한 빌드가 없습니다.</p> : null}
        <ul className="checks">
          {builds?.map((b) => (
            <BuildRow key={b.id} build={b} devices={devices.filter((d) => d.platform === b.target)} disabled={busy !== null || projectBusy} onInstall={(deviceId, deviceName) =>
              void act("설치", async () => {
                const r = await window.qa.builds.install({ buildId: b.id, deviceId });
                return r.installed ? `${deviceName} 에 설치했습니다: ${r.appId}` : `설치 명령은 끝났지만 ${deviceName} 에서 ${r.appId} 를 찾지 못했습니다`;
              })
            } />
          ))}
        </ul>
      </section>
    </>
  );
}

function BuildRow(props: { build: Build; devices: Device[]; disabled: boolean; onInstall: (deviceId: string, deviceName: string) => void }) {
  const { build: b, devices } = props;
  const [deviceId, setDeviceId] = useState("");
  const selected = devices.find((d) => d.id === deviceId) ?? devices[0];
  return (
    <li className="check" data-testid={`build-${b.id}`}>
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
      {devices.length > 0 ? (
        <div className="row">
          <select aria-label="설치할 기기" value={selected?.id ?? ""} onChange={(e) => setDeviceId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={props.disabled || !selected} onClick={() => selected && props.onInstall(selected.id, selected.name)}>
            설치
          </button>
        </div>
      ) : (
        <small className="hint">실행 중인 {TARGET_TEXT[b.target]} 기기 없음</small>
      )}
    </li>
  );
}
