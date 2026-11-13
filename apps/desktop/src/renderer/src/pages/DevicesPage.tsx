import type { Device, DeviceList, IosDeviceOptions, IosDeviceReadiness } from "@qa/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../lib/errors";
import { deviceKindText } from "../lib/device-label";
import { useDevicePolling } from "../lib/use-device-polling";

const STATE_TEXT: Record<Device["state"], string> = { booted: "실행 중", shutdown: "꺼짐", booting: "부팅 중", unknown: "알 수 없음" };
/** 좁은 칸이라 탭 글자는 짧게 쓰고, 읽어 주는 이름(name)은 풀어서 쓴다 */
const PREPARE_TABS = [
  { id: "ios", label: "iOS", name: "iOS 시뮬레이터" },
  { id: "android", label: "Android", name: "Android 에뮬레이터" },
  { id: "phone", label: "Android 폰", name: "Android 폰" },
  { id: "iphone", label: "iPhone", name: "iPhone 실기기" },
] as const;
type PrepareTab = (typeof PREPARE_TABS)[number]["id"];

/**
 * 기기: 왼쪽은 기기 목록(실행 중인 것이 먼저), 오른쪽은 기기 준비(iOS 시뮬레이터 | Android 에뮬레이터 | Android 폰 | iPhone).
 * 준비는 설정의 기기 언어로 맞추고 애니메이션을 줄인다. 직접 만든 시뮬레이터와 사람의 폰은 건드리지 않는다.
 * iPhone 은 설정을 바꾸지 않고 쓸 수 있는지만 점검하고, 처음 한 번 러너를 서명해 올린다(ADR 0034)
 */
export function DevicesPage() {
  const [tab, setTab] = useState<PrepareTab>("ios");
  const [list, setList] = useState<DeviceList | null>(null);
  const [options, setOptions] = useState<IosDeviceOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState("");
  const [deviceType, setDeviceType] = useState("");
  const [avd, setAvd] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [iphoneId, setIphoneId] = useState("");
  const [readiness, setReadiness] = useState<IosDeviceReadiness | null>(null);

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

  const avds = useMemo(() => list?.devices.filter((d) => d.kind === "emulator") ?? [], [list]);
  const phones = list?.devices.filter((d) => d.kind === "real" && d.platform === "android") ?? [];
  const iphones = useMemo(() => list?.devices.filter((d) => d.kind === "real" && d.platform === "ios") ?? [], [list]);
  useEffect(() => {
    if (iphones.some((d) => d.id === iphoneId)) return;
    // 연결된 것을 먼저 고른다(케이블로 꽂은 기기)
    setIphoneId((iphones.find((d) => d.state === "booted") ?? iphones[0])?.id ?? "");
  }, [iphones, iphoneId]);

  const checkIphone = useCallback(async (id: string, buildRunner: boolean) => {
    if (!id) return;
    const label = buildRunner ? "iPhone 준비" : "iPhone 확인";
    setBusy(label);
    setMessage(null);
    try {
      const r = await window.qa.devices.checkIosDevice({ id, buildRunner });
      setReadiness(r);
      const name = iphonesRef.current.find((d) => d.id === id)?.name ?? "iPhone";
      const todo = r.checks.filter((c) => !c.ok).length;
      setMessage(r.ready ? `${name}: 준비됨 · 실행 화면에서 고를 수 있습니다` : `할 일 ${todo}개를 마치고 다시 확인합니다`);
    } catch (e) {
      setReadiness(null);
      setMessage(`${label} 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
      if (buildRunner) await reload();
    }
  }, [reload]);
  const iphonesRef = useRef(iphones);
  iphonesRef.current = iphones;
  // 새로고침을 누르지 않아도 꽂고 뺀 기기가 목록에 반영된다(준비·삭제 중에는 쉰다)
  useDevicePolling(setList, { paused: busy !== null, onError: (e) => setMessage(errorMessage(e)) });
  // 고른 iPhone 의 연결 상태가 바뀌면(케이블을 꽂음·뺌, 개발자 모드) 저절로 다시 점검한다
  const selectedKey = `${iphoneId}:${iphones.find((d) => d.id === iphoneId)?.state ?? "none"}`;
  const lastKey = useRef(selectedKey);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = selectedKey;
    if (previous === selectedKey || previous.split(":")[0] !== iphoneId) return;
    if (tab !== "iphone" || !iphoneId || busy !== null) return;
    // 지금 점검 결과의 "연결"이 새 상태와 같으면 다시 하지 않는다(준비 직후 목록이 바뀌어도 러너 결과를 지우지 않게)
    const connectedOk = readiness?.deviceId === iphoneId ? readiness.checks.find((c) => c.id === "connected")?.ok : undefined;
    if (connectedOk !== undefined && connectedOk === selectedKey.endsWith(":booted")) return;
    void checkIphone(iphoneId, false);
  }, [selectedKey, iphoneId, tab, busy, checkIphone, readiness]);
  // iPhone 탭을 열거나 다른 iPhone 을 고르면 점검한다(러너는 빌드하지 않는다)
  useEffect(() => {
    if (tab !== "iphone" || !iphoneId) return;
    if (readiness?.deviceId === iphoneId) return;
    void checkIphone(iphoneId, false);
  }, [tab, iphoneId, readiness, checkIphone]);
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

  const running = list?.devices.filter((d) => d.state === "booted") ?? [];
  const idle = list?.devices.filter((d) => d.state !== "booted") ?? [];

  const row = (d: Device) => (
    <li key={`${d.platform}:${d.id}`} className="check" data-testid={`device-${d.platform}-${d.id}`}>
      <span className={`badge ${d.state === "booted" ? "ok" : ""}`}>{d.kind === "real" ? (d.state === "booted" ? "연결됨" : d.platform === "ios" ? "준비 필요" : "허용 필요") : STATE_TEXT[d.state]}</span>
      <div className="check-body">
        <strong>{d.name}</strong>
        <small className="hint">{deviceKindText(d)}</small>
      </div>
      <div className="row">
        {d.state === "booted" && d.kind !== "real" ? (
          <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void act("종료", () => window.qa.devices.shutdown({ platform: d.platform, id: d.id }))}>
            종료
          </button>
        ) : null}
        {d.platform === "ios" && d.managed ? (
          confirmDelete === d.id ? (
            <>
              <button type="button" className="danger small" disabled={busy !== null} onClick={() => void remove(d)}>
                {busy === "삭제" ? "지우는 중" : "정말 삭제"}
              </button>
              <button type="button" className="secondary small" disabled={busy !== null} onClick={() => setConfirmDelete(null)}>
                취소
              </button>
            </>
          ) : (
            <button type="button" className="secondary small" disabled={busy !== null} onClick={() => setConfirmDelete(d.id)}>
              삭제
            </button>
          )
        ) : null}
      </div>
    </li>
  );

  return (
    <div className="split-page">
      <h1>기기</h1>
      <div className="split-panes side-right">
        <section className="card pane" aria-label="기기 목록">
          <div className="pane-head">
            <div className="pane-head-title">
              <h2>기기 목록</h2>
              <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void reload()}>
                새로고침
              </button>
            </div>
            <small className="hint">실행·플로우 만들기는 실행 중인 기기에서 고릅니다. iOS 는 앱이 만든 시뮬레이터만 보입니다.</small>
          </div>
          <div className="pane-body">
            {list === null ? <p>불러오는 중</p> : null}
            {list && list.devices.length === 0 ? <p className="hint">QA 기기가 없습니다. 오른쪽에서 준비합니다.</p> : null}
            {running.length > 0 ? (
              <>
                <strong className="group-label">실행 중 {running.length}대</strong>
                <ul className="checks">{running.map(row)}</ul>
              </>
            ) : null}
            {idle.length > 0 ? (
              <>
                <strong className="group-label">
                  {idle.some((d) => d.kind === "real") ? "꺼짐·준비 필요" : "꺼짐"} {idle.length}대
                </strong>
                <ul className="checks">{idle.map(row)}</ul>
              </>
            ) : null}
            {phones.some((d) => d.state !== "booted") ? (
              <p className="hint" role="status" data-testid="phone-unauthorized">
                연결된 폰이 아직 허용되지 않았습니다. 폰 화면의 &quot;USB 디버깅을 허용하시겠습니까?&quot; 창에서 허용하면 잠시 뒤 저절로 바뀝니다.
              </p>
            ) : null}
            {confirmDelete ? (
              <p className="warning" role="alert">
                시뮬레이터와 그 안에 설치한 앱·데이터가 모두 지워집니다. 되돌릴 수 없습니다.
              </p>
            ) : null}
          </div>
        </section>

        <section className="card pane" aria-label="QA 기기 준비">
          <div className="pane-head">
            <h2>기기 준비</h2>
            <small className="hint">{tab === "iphone" ? "iPhone 은 설정을 바꾸지 않고, 쓸 수 있는지만 점검합니다." : "설정의 기기 언어로 맞추고 애니메이션을 줄여 준비합니다(1~3분)."}</small>
          </div>
          <div className="pane-body">
            <div role="tablist" aria-label="준비할 기기">
              {PREPARE_TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-label={t.name} title={t.name} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            {tab === "ios" ? (
              <>
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
                <p className="hint">고른 기종·iOS 버전으로 앱 전용 시뮬레이터를 만듭니다(이미 있으면 다시 씁니다). 직접 만든 시뮬레이터는 건드리지 않습니다.</p>
                {optionsError ? <p className="hint">설치된 iOS 버전을 읽지 못했습니다. 기본 기종으로 준비합니다. ({optionsError})</p> : null}
                {options && options.runtimes.length === 0 ? <p className="hint">iOS 런타임이 없습니다. Xcode → Settings → Components 에서 설치합니다.</p> : null}
              </>
            ) : null}
            {tab === "android" ? (
              <>
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
                <p className="hint">고른 AVD 를 화면 없이 띄웁니다.</p>
                {list && !list.androidAvailable ? <p className="hint">Android SDK 를 찾지 못했습니다. Android 테스트에만 필요합니다.</p> : null}
                {list?.androidAvailable && avds.length === 0 ? <p className="hint">AVD 가 없습니다. Android Studio 의 Device Manager 에서 만듭니다.</p> : null}
              </>
            ) : null}
            {tab === "phone" ? (
              <p className="hint" data-testid="phone-hint">
                Android 폰은 개발자 옵션에서 USB 디버깅을 켜고 케이블로 연결하면 잠시 뒤 목록에 저절로 나옵니다. 폰의 언어·애니메이션 설정은 바꾸지 않습니다.
              </p>
            ) : null}
            {tab === "iphone" ? (
              <>
                <label>
                  iPhone
                  <select aria-label="iPhone" value={iphoneId} onChange={(e) => setIphoneId(e.target.value)} disabled={iphones.length === 0 || busy !== null}>
                    {iphones.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} (iOS {d.osVersion})
                      </option>
                    ))}
                  </select>
                </label>
                {iphones.length === 0 ? <p className="hint">연결된 iPhone 이 없습니다. 케이블로 연결하고 iPhone 에서 &quot;이 컴퓨터 신뢰&quot;를 누르면 잠시 뒤 저절로 나옵니다.</p> : null}
                {readiness && readiness.deviceId === iphoneId ? (
                  <ul className="checks" data-testid="iphone-checks">
                    {readiness.checks.map((c) => (
                      <li key={c.id} className="check" data-testid={`iphone-check-${c.id}`}>
                        <span className={`badge ${c.ok ? "ok" : "warn"}`}>{c.ok ? "확인" : "할 일"}</span>
                        <div className="check-body">
                          <strong>{c.label}</strong>
                          <small className="hint">{c.detail}</small>
                          {!c.ok && c.id === "devToolsSecurity" ? <code className="command">sudo DevToolsSecurity -enable</code> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="hint">iPhone 에는 빌드를 설치하지 않고, TestFlight·App Store·Xcode 로 설치한 앱을 그대로 재생합니다. 처음 한 번 러너를 서명해 올립니다(몇 분). 플로우 만들기는 시뮬레이터에서 합니다.</p>
              </>
            ) : null}
            {message ? (
              <p role="status" data-testid="device-message">
                {message}
              </p>
            ) : null}
          </div>
          <div className="pane-foot">
            {tab === "ios" ? (
              <button type="button" disabled={busy !== null} onClick={() => void act("iOS 준비", () => window.qa.devices.prepareIos(runtime && deviceType ? { deviceType, runtime } : {}))}>
                {busy === "iOS 준비" ? "iOS 준비 중" : "iOS 시뮬레이터 준비"}
              </button>
            ) : null}
            {tab === "android" ? (
              <button type="button" disabled={busy !== null || !list?.androidAvailable || avds.length === 0} onClick={() => void act("Android 준비", () => window.qa.devices.prepareAndroid(avd ? { avd } : {}))}>
                {busy === "Android 준비" ? "Android 준비 중" : "Android 에뮬레이터 준비"}
              </button>
            ) : null}
            {tab === "phone" ? (
              <button type="button" className="secondary" disabled={busy !== null} onClick={() => void reload()}>
                연결한 폰 찾기
              </button>
            ) : null}
            {tab === "iphone" ? (
              <>
                <button type="button" className="secondary" disabled={busy !== null || !iphoneId} onClick={() => void checkIphone(iphoneId, false)}>
                  {busy === "iPhone 확인" ? "확인 중" : "다시 확인"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !iphoneId || !readiness || readiness.deviceId !== iphoneId || readiness.checks.some((c) => !c.ok && c.id !== "tool" && c.id !== "runner")}
                  onClick={() => void checkIphone(iphoneId, true)}
                >
                  {busy === "iPhone 준비" ? "러너 준비 중(몇 분)" : readiness?.checks.some((c) => c.id === "runner" && c.ok) ? "러너 다시 준비" : "iPhone 준비"}
                </button>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
