import type { UpdateStatus } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";
import { notifyUpdateStatus, onUpdateStatus } from "../lib/update-events";

/** 앱이 켜진 직후 첫 확인(main 이 시작 5초 뒤에 한다)이 끝날 때까지 다시 읽는 간격과 횟수 */
const STARTUP_POLL_MS = 3_000;
const STARTUP_POLL_TRIES = 20;

/**
 * 새 버전 알림(PLAN 11장). 받기를 누르면 main 이 SHA-256·서명을 확인한다.
 * 재시작으로 적용할 수 있으면 받은 뒤 "재시작해서 업데이트"를 보이고(ADR 0027), 아니면 확인된 설치 파일(.dmg)을 연다
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const next = await window.qa.update.status().catch(() => null);
      if (stopped || !next) return;
      setStatus(next);
      // 아직 한 번도 확인하지 않았으면(앱이 막 켜졌다) 첫 확인이 끝날 때까지 잠깐씩 다시 읽는다
      if (next.checkedAt === null && tries < STARTUP_POLL_TRIES) {
        tries += 1;
        retry = setTimeout(() => void load(), STARTUP_POLL_MS);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10 * 60_000);
    // 설정의 "새 버전 확인" 결과를 바로 반영한다
    const off = onUpdateStatus(setStatus);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(timer);
      off();
    };
  }, []);

  if (!status?.available || !status.release) return null;
  const release = status.release;
  const auto = status.autoInstall;

  async function download() {
    setMessage(auto.possible ? "받는 중입니다. 확인이 끝나면 재시작 버튼이 나옵니다" : "받는 중");
    // 받는 동안 버튼을 끈다(main 의 busy 를 화면에 바로 반영)
    setStatus((prev) => (prev ? { ...prev, busy: true } : prev));
    try {
      const next = await window.qa.update.download();
      setStatus(next);
      notifyUpdateStatus(next);
      // Squirrel.Mac 은 준비한 업데이트를 앱을 끝낼 때도 적용한다
      if (next.autoInstall.ready) setMessage("준비됐습니다. 재시작하면 새 버전이 적용됩니다(앱을 끝낼 때도 적용됩니다)");
      else setMessage(next.downloaded?.opened ? "설치 파일을 열었습니다" : (next.error ?? "받았습니다"));
    } catch (e) {
      setMessage(`받지 못했습니다: ${errorMessage(e)}`);
      const next = await window.qa.update.status().catch(() => null);
      if (next) setStatus(next);
    }
  }

  async function install() {
    try {
      await window.qa.update.install();
      setMessage("재시작합니다");
    } catch (e) {
      setMessage(`재시작하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  return (
    <div className="card row" role="status" data-testid="update-banner">
      <strong>새 버전 {release.tag}</strong>
      <span className="hint">지금 {status.current}</span>
      {auto.ready ? (
        <button type="button" onClick={() => void install()}>
          재시작해서 업데이트
        </button>
      ) : (
        <button type="button" disabled={status.busy} onClick={() => void download()}>
          {auto.possible ? "받기" : "설치 파일 받기"}
        </button>
      )}
      <button type="button" className="secondary" onClick={() => void window.qa.app.openExternal({ url: release.url }).catch((e: unknown) => setMessage(errorMessage(e)))}>
        릴리스 보기
      </button>
      {message ? <small className="hint">{message}</small> : !auto.possible && auto.reason ? <small className="hint">{auto.reason}</small> : null}
    </div>
  );
}
