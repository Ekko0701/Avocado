import type { UpdateStatus } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";
import { notifyUpdateStatus, onUpdateStatus } from "../lib/update-events";

/** 앱이 켜진 직후 첫 확인(main 이 시작 5초 뒤에 한다)이 끝날 때까지 다시 읽는 간격과 횟수 */
const STARTUP_POLL_MS = 3_000;
const STARTUP_POLL_TRIES = 20;

/** 새 버전 알림(PLAN 11장). 받기를 누르면 main 이 SHA-256·서명을 확인하고, 확인된 것만 연다 */
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

  async function download() {
    setMessage("받는 중");
    try {
      const next = await window.qa.update.download();
      setStatus(next);
      notifyUpdateStatus(next);
      setMessage(next.downloaded?.opened ? "설치 파일을 열었습니다" : (next.error ?? "받았습니다"));
    } catch (e) {
      setMessage(`받지 못했습니다: ${errorMessage(e)}`);
    }
  }

  return (
    <div className="card row" role="status" data-testid="update-banner">
      <strong>새 버전 {release.tag}</strong>
      <span className="hint">지금 {status.current}</span>
      <button type="button" disabled={status.busy} onClick={() => void download()}>
        받기
      </button>
      <button type="button" className="secondary" onClick={() => void window.qa.app.openExternal({ url: release.url }).catch((e: unknown) => setMessage(errorMessage(e)))}>
        릴리스 보기
      </button>
      {message ? <small className="hint">{message}</small> : null}
    </div>
  );
}
