import type { UploadPreview, UploadRecord } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage, formatDateTime } from "../lib/errors";
import { BundlePreview, kb, PrivacyCheck } from "./BundlePreview";

/**
 * 증적 요약 묶음 올리기(PLAN 9.3·9.4). 정책 스위치(D11)가 꺼져 있으면 아무것도 보이지 않는다.
 * 미리보기 → "개인정보 확인함" 체크 → 업로드. 비밀 값이 남으면 막힌다.
 */
export function EvidenceUploadPanel(props: { runId: string; executionId: string; finished: boolean; passed: boolean }) {
  const [approved, setApproved] = useState(false);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [includeScreens, setIncludeScreens] = useState(false);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { runId, executionId } = props;

  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
    setMessage(null);
    window.qa.settings.get().then((s) => setApproved(s.settings.policy.evidenceUploadApproved), () => setApproved(false));
    window.qa.evidence.uploads({ runId, executionId }).then(setUploads, () => setUploads([]));
  }, [runId, executionId]);

  if (!approved || !props.finished) return null;

  async function prepare() {
    setBusy(true);
    setMessage(null);
    setConfirmed(false);
    try {
      setPreview(await window.qa.evidence.prepareUpload({ runId, executionId, includePassScreens: includeScreens }));
    } catch (e) {
      setMessage(`묶음을 만들지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!preview?.bundleId || !confirmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const record = await window.qa.evidence.upload({ bundleId: preview.bundleId, privacyConfirmed: true });
      setUploads([record, ...uploads]);
      setPreview(null);
      setMessage("올렸습니다");
    } catch (e) {
      setMessage(`올리지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" aria-label="증적 올리기" data-testid="evidence-upload">
      {uploads.map((u) => (
        <div key={u.commitSha} className="row" data-testid="upload-record">
          <span className="badge ok">올림</span>
          <code>{u.url}</code>
          <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(u.url).then(() => setMessage("주소를 복사했습니다"), (e: unknown) => setMessage(errorMessage(e)))}>
            복사
          </button>
          <button type="button" className="secondary" onClick={() => void window.qa.app.openExternal({ url: u.url }).catch((e: unknown) => setMessage(errorMessage(e)))}>
            열기
          </button>
          <small className="hint">
            {u.repo} · {kb(u.bytes)} · {formatDateTime(u.uploadedAt)}
          </small>
        </div>
      ))}
      <p className="hint">가린 사본으로 요약 묶음(run.json, report.md, 캡처 JPEG, 실패 로그 발췌)을 만들어 증적 저장소에 올립니다. 원본과 영상은 올리지 않습니다.</p>
      <div className="row">
        {props.passed ? (
          <label className="check">
            <input type="checkbox" checked={includeScreens} onChange={(e) => setIncludeScreens(e.target.checked)} />
            통과 실행의 화면 캡처도 넣기
          </label>
        ) : null}
        <button type="button" className="secondary" disabled={busy} onClick={() => void prepare()}>
          요약 묶음 만들기
        </button>
      </div>
      {preview ? (
        <BundlePreview preview={preview} where={`${preview.repo} / ${preview.root}`} action="올릴" testId="upload-preview">
          <div className="row">
            <PrivacyCheck checked={confirmed} onChange={setConfirmed} />
            <button type="button" disabled={!confirmed || busy} onClick={() => void upload()}>
              업로드
            </button>
          </div>
        </BundlePreview>
      ) : null}
      {message ? (
        <p role="status" className="hint" data-testid="upload-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
