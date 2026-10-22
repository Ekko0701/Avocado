import type { Device, DeviceList } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";

const STATE_TEXT: Record<Device["state"], string> = { booted: "실행 중", shutdown: "꺼짐", booting: "부팅 중", unknown: "알 수 없음" };

export function DevicesPage() {
  const [list, setList] = useState<DeviceList | null>(null);
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
  }, [reload]);

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

  return (
    <>
      <h1>기기</h1>
      <section className="card stack" aria-label="QA 기기 준비">
        <p className="hint">
          QA 기기를 설정의 기기 언어로 맞추고 애니메이션을 줄여 준비합니다. iOS 는 앱 전용 시뮬레이터를 만들고, Android 는 기존 AVD 를 화면 없이 띄웁니다.
        </p>
        <div className="row">
          <button type="button" disabled={busy !== null} onClick={() => void act("iOS 준비", () => window.qa.devices.prepareIos({}))}>
            {busy === "iOS 준비" ? "iOS 준비 중" : "iOS 시뮬레이터 준비"}
          </button>
          <button
            type="button"
            disabled={busy !== null || !list?.androidAvailable}
            onClick={() => void act("Android 준비", () => window.qa.devices.prepareAndroid({}))}
          >
            {busy === "Android 준비" ? "Android 준비 중" : "Android 에뮬레이터 준비"}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void reload()}>
            새로고침
          </button>
        </div>
        {list && !list.androidAvailable ? <p className="hint">Android SDK 를 찾지 못했습니다. Android 테스트에만 필요합니다.</p> : null}
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
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
