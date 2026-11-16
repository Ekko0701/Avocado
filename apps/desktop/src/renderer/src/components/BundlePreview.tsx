import type { BundlePreview as Preview } from "@qa/shared";
import type { ReactNode } from "react";

const KIND: Record<string, string> = { run_json: "메타", report: "보고서", screen: "화면 캡처", failure_screen: "실패 캡처", hierarchy: "뷰 계층", log: "로그 발췌" };
export const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

/**
 * 앱 밖으로 내보내는 요약 묶음의 미리보기(올리기·폴더로 내보내기 공통, PLAN 9.3). 비밀 값이 남았으면 경로와 개수만 보이고 막는다.
 * 막히지 않았을 때만 children(개인정보 확인과 실행 버튼)을 보인다.
 */
export function BundlePreview(props: { preview: Preview; where: string; action: "올릴" | "내보낼"; testId: string; children: ReactNode }) {
  const { preview } = props;
  return (
    <div className="stack" data-testid={props.testId}>
      {preview.blocked ? (
        <p role="alert" className="error">
          묶음에 비밀 값이 남아 있어 {props.action} 수 없습니다: {preview.residue.map((r) => `${r.path}(${r.occurrences + r.patternMatches}곳${r.inPath ? ", 경로" : ""})`).join(", ")}
        </p>
      ) : null}
      {preview.warnings.map((w) => (
        <small key={w} className="warning">
          {w}
        </small>
      ))}
      <p className="hint">
        {props.where} · {preview.files.length}개 · {kb(preview.totalBytes)}
      </p>
      <ul className="checks">
        {preview.files.map((f) => (
          <li key={f.path}>
            <code>{f.path}</code> <small className="hint">{KIND[f.kind] ?? f.kind} · {kb(f.bytes)}</small>
          </li>
        ))}
      </ul>
      {preview.thumbnails.length > 0 ? (
        <div className="row">
          {preview.thumbnails.map((t) => (
            <img key={t.path} src={t.dataUrl} alt={t.path} title={t.path} style={{ maxHeight: 160, border: "1px solid var(--border)", borderRadius: 4 }} />
          ))}
        </div>
      ) : null}
      {!preview.blocked ? props.children : null}
    </div>
  );
}

export function PrivacyCheck(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      개인정보 확인함 (캡처·뷰 계층·로그에 실제 사용자 정보가 없다)
    </label>
  );
}
