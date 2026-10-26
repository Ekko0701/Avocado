import type { Device, DeviceList, IosDeviceOptions } from "@qa/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../lib/errors";

const STATE_TEXT: Record<Device["state"], string> = { booted: "실행 중", shutdown: "꺼짐", booting: "부팅 중", unknown: "알 수 없음" };

export function DevicesPage() {
  const [list, setList] = useState<DeviceList | null>(null);
  const [options, setOptions] = useState<IosDeviceOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState("");
  const [deviceType, setDeviceType] = useState("");
  const [avd, setAvd] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setList(await window.qa.devices.list());
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    window.qa.devices.iosOptions().then(
      (o) => {
        setOptions(o);
        // 기본 기종을 지원하는 가장 새 iOS 를 고른다(없으면 가장 새 iOS)
        const first = o.runtimes.find((r) => r.deviceTypes.some((t) => t.name === o.defaultDeviceType)) ?? o.runtimes[0];
        if (first) setRuntime(first.id);
      },
      (e: unknown) => setOptionsError(errorMessage(e)),
    );
  }, [reload]);

  const types = useMemo(() => options?.runtimes.find((r) => r.id === runtime)?.deviceTypes ?? [], [options, runtime]);
  // iOS 버전을 바꾸면 그 버전에 있는 기종으로 맞춘다(같은 기종 → 기본 기종 → 첫 iPhone)
  useEffect(() => {
    if (types.length === 0) return;
    setDeviceType((current) =>
      types.some((t) => t.name === current) ? current : (types.find((t) => t.name === options?.defaultDeviceType) ?? types.find((t) => t.family === "iPhone") ?? types[0])?.name ?? "",
    );
  }, [types, options]);

  const avds = useMemo(() => list?.devices.filter((d) => d.platform === "android") ?? [], [list]);
  useEffect(() => {
    if (avds.length === 0 || avds.some((d) => d.id === avd)) return;
    setAvd((avds.find((d) => d.managed) ?? avds[0])?.id ?? "");
  }, [avds, avd]);

  async function act(label: string, action: () => Promise<Device>) {
    setBusy(label);
    setMessage(null);
    try {
      const device = await action();
      setMessage(`${device.name}: ${STATE_TEXT[device.state]}${device.locale ? ` · 언어 ${device.locale}` : ""}`);
    } catch (e) {
      setMessage(`${label} 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
      await reload();
    }
  }

  async function remove(d: Device) {
    setBusy("삭제");
    setMessage(null);
    try {
      setList(await window.qa.devices.deleteIos({ id: d.id }));
      setMessage(`${d.name} 을 지웠습니다`);
    } catch (e) {
      setMessage(`삭제 실패: ${errorMessage(e)}`);
      await reload();
    } finally {
      setConfirmDelete(null);
      setBusy(null);
    }
  }

  return (
    <>
      <h1>기기</h1>
      <section className="card stack" aria-label="QA 기기 준비">
        <p className="hint">
          QA 기기를 설정의 기기 언어로 맞추고 애니메이션을 줄여 준비합니다. iOS 는 고른 기종·iOS 버전으로 앱 전용 시뮬레이터를 만들고(이미 있으면 다시 씁니다), Android 는
          고른 AVD 를 화면 없이 띄웁니다. 직접 만든 시뮬레이터는 건드리지 않습니다.
        </p>
        <div className="row">
          <label>
            iOS 버전
            <select aria-label="iOS 버전" value={runtime} onChange={(e) => setRuntime(e.target.value)} disabled={!options || busy !== null}>
              {options?.runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  iOS {r.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            기종
            <select aria-label="기종" value={deviceType} onChange={(e) => setDeviceType(e.target.value)} disabled={!options || busy !== null}>
              {(["iPhone", "iPad"] as const).map((family) =>
                types.some((t) => t.family === family) ? (
                  <optgroup key={family} label={family}>
                    {types
                      .filter((t) => t.family === family)
                      .map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                  </optgroup>
                ) : null,
              )}
            </select>
          </label>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("iOS 준비", () => window.qa.devices.prepareIos(runtime && deviceType ? { deviceType, runtime } : {}))}
          >
            {busy === "iOS 준비" ? "iOS 준비 중" : "iOS 시뮬레이터 준비"}
          </button>
        </div>
        {optionsError ? <p className="hint">설치된 iOS 버전을 읽지 못했습니다. 기본 기종으로 준비합니다. ({optionsError})</p> : null}
        {options && options.runtimes.length === 0 ? <p className="hint">iOS 런타임이 없습니다. Xcode → Settings → Components 에서 설치합니다.</p> : null}
        <div className="row">
          <label>
            AVD
            <select aria-label="AVD" value={avd} onChange={(e) => setAvd(e.target.value)} disabled={avds.length === 0 || busy !== null}>
              {avds.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy !== null || !list?.androidAvailable || avds.length === 0}
            onClick={() => void act("Android 준비", () => window.qa.devices.prepareAndroid(avd ? { avd } : {}))}
          >
            {busy === "Android 준비" ? "Android 준비 중" : "Android 에뮬레이터 준비"}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void reload()}>
            새로고침
          </button>
        </div>
        {list && !list.androidAvailable ? <p className="hint">Android SDK 를 찾지 못했습니다. Android 테스트에만 필요합니다.</p> : null}
        {list?.androidAvailable && avds.length === 0 ? <p className="hint">AVD 가 없습니다. Android Studio 의 Device Manager 에서 만듭니다.</p> : null}
        {message ? (
          <p role="status" data-testid="device-message">
            {message}
          </p>
        ) : null}
      </section>
      <section className="card stack" aria-label="기기 목록">
        {list === null ? <p>불러오는 중</p> : null}
        {list && list.devices.length === 0 ? <p className="hint">QA 기기가 없습니다.</p> : null}
        <ul className="checks">
          {list?.devices.map((d) => (
            <li key={`${d.platform}:${d.id}`} className="check" data-testid={`device-${d.platform}-${d.id}`}>
              <span className={`badge ${d.state === "booted" ? "ok" : ""}`}>{STATE_TEXT[d.state]}</span>
              <div className="check-body">
                <strong>{d.name}</strong>
                <small className="hint">
                  {d.platform === "ios" ? `iOS ${d.osVersion} 시뮬레이터` : `Android 에뮬레이터${d.serial ? ` · ${d.serial}` : ""}`}
                </small>
              </div>
              <div className="row">
                {d.state === "booted" ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => void act("종료", () => window.qa.devices.shutdown({ platform: d.platform, id: d.id }))}
                  >
                    종료
                  </button>
                ) : null}
                {d.platform === "ios" && d.managed ? (
                  confirmDelete === d.id ? (
                    <>
                      <button type="button" className="danger" disabled={busy !== null} onClick={() => void remove(d)}>
                        {busy === "삭제" ? "지우는 중" : "정말 삭제"}
                      </button>
                      <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirmDelete(null)}>
                        취소
                      </button>
                    </>
                  ) : (
                    <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirmDelete(d.id)}>
                      삭제
                    </button>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {confirmDelete ? (
          <p className="warning" role="alert">
            시뮬레이터와 그 안에 설치한 앱·데이터가 모두 지워집니다. 되돌릴 수 없습니다.
          </p>
        ) : null}
      </section>
    </>
  );
}
