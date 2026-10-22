import type { UpdateStatus } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";

/** 새 버전 알림(PLAN 11장). 받기를 누르면 main 이 SHA-256·서명을 확인하고, 확인된 것만 연다 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const load = () => window.qa.update.status().then(setStatus, () => undefined);
    void load();
    const timer = setInterval(() => void load(), 10 * 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!status?.available || !status.release) return null;
  const release = status.release;

  async function download() {
    setMessage("받는 중");
    try {
      const next = await window.qa.update.download();
      setStatus(next);
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
