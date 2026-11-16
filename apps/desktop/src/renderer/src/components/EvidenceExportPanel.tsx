import type { EvidenceExportRecord, ExportPreview } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";
import { BundlePreview, kb, PrivacyCheck } from "./BundlePreview";

/**
 * 증적 폴더로 내보내기(ADR 0036 결정 9). 버그를 알릴 때 건넬 요약 묶음을 고른 폴더에 쓴다.
 * 게이트는 올리기와 같다(미리보기 → "개인정보 확인함", 비밀 값이 남으면 막힘). 정책 스위치(D11)·워크스페이스 출처와 상관없이 있다.
 */
export function EvidenceExportPanel(props: { runId: string; executionId: string; passed: boolean }) {
  const [exports, setExports] = useState<EvidenceExportRecord[]>([]);
  const [includeScreens, setIncludeScreens] = useState(false);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { runId, executionId } = props;

  useEffect(() => {
    setExports([]);
    setPreview(null);
    setConfirmed(false);
    setMessage(null);
  }, [runId, executionId]);

  async function prepare() {
    setBusy(true);
    setMessage(null);
    setConfirmed(false);
    try {
      setPreview(await window.qa.evidence.prepareExport({ runId, executionId, includePassScreens: includeScreens }));
    } catch (e) {
      setMessage(`묶음을 만들지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportTo() {
    if (!preview?.bundleId || !confirmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const record = await window.qa.evidence.export({ bundleId: preview.bundleId, privacyConfirmed: true });
      if (record === null) {
        setMessage("폴더를 고르지 않아 내보내지 않았습니다");
        return;
      }
      setExports([record, ...exports]);
      setPreview(null);
      setMessage("내보냈습니다. 같은 실행을 다시 내보내면 이름 뒤에 -2 가 붙은 새 폴더가 생깁니다.");
    } catch (e) {
      setMessage(`내보내지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" aria-label="폴더로 내보내기" data-testid="evidence-export">
      {exports.map((x) => (
        <div key={x.exportId} className="row" data-testid="export-record">
          <span className="badge ok">내보냄</span>
          <code>{x.folder}</code>
          <button type="button" className="secondary" onClick={() => void window.qa.evidence.revealExport({ exportId: x.exportId }).catch((e: unknown) => setMessage(errorMessage(e)))}>
            Finder 에서 보기
          </button>
          <small className="hint">
            {x.files}개 · {kb(x.bytes)}
          </small>
        </div>
      ))}
      <p className="hint">가린 사본으로 요약 묶음(run.json, report.md, 캡처 JPEG, 실패 로그 발췌)을 만들어 고른 폴더에 저장합니다. 원본과 영상은 넣지 않습니다. 버그를 알릴 때 이 폴더를 건넵니다.</p>
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
        <BundlePreview preview={preview} where={preview.folderName} action="내보낼" testId="export-preview">
          <div className="row">
            <PrivacyCheck checked={confirmed} onChange={setConfirmed} />
            <button type="button" disabled={!confirmed || busy} onClick={() => void exportTo()}>
              폴더로 내보내기…
            </button>
          </div>
        </BundlePreview>
      ) : null}
      {message ? (
        <p role="status" className="hint" data-testid="export-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
