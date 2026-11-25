import { useState } from "react";
import { defaultSubflowRows, emptyFirstApp, firstAppInput, firstAppProblems, type FirstAppDraft } from "../lib/app-form";
import { errorMessage } from "../lib/errors";
import { notifyWorkspaceChanged } from "../lib/workspace-events";
import { AppNameField } from "./AppNameField";
import { TargetFieldset } from "./AppSettingsEditor";

/** 첫 앱 등록의 입력과 저장. 마법사의 첫 앱 단계와 빈 로컬 워크스페이스 화면이 같이 쓰고, 버튼 자리는 각자 둔다 */
export function useFirstApp(existing: readonly string[]) {
  const [draft, setDraft] = useState<FirstAppDraft>(emptyFirstApp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = firstAppProblems(draft, existing);

  /** 등록하면 그 앱 id, 실패하면 null(이유는 error) */
  async function register(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      const input = firstAppInput(draft);
      await window.qa.workspace.saveApp(input);
      notifyWorkspaceChanged();
      setDraft(emptyFirstApp());
      return input.app;
    } catch (e) {
      setError(`앱을 등록하지 못했습니다: ${errorMessage(e)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { draft, setDraft, problems, busy, error, canRegister: !busy && problems.length === 0, register };
}

export function FirstAppFields(props: { draft: FirstAppDraft; onChange: (next: FirstAppDraft) => void; problems: string[]; error: string | null }) {
  const { draft } = props;
  const rows = defaultSubflowRows(draft.targets);
  // 아직 아무것도 쓰지 않았으면 형식 문제를 늘어놓지 않는다(버튼만 막는다)
  const touched = draft.id.trim() !== "" || draft.name.trim() !== "";
  return (
    <div className="stack" data-testid="first-app">
      <AppNameField value={draft} onChange={(next) => props.onChange({ ...draft, ...next })} />
      <TargetFieldset targets={draft.targets} onChange={(id, next) => props.onChange({ ...draft, targets: { ...draft.targets, [id]: { ...draft.targets[id], ...next } } })} />
      {rows.length > 0 ? (
        <>
          <strong>함께 만드는 공통 서브플로우</strong>
          <ul className="checks" data-testid="first-app-subflows">
            {rows.map((r) => (
              <li key={`${r.target}/${r.path}`} className="check">
                <span className="badge">{r.label}</span>
                <div className="check-body">
                  <strong>
                    <code>{r.path}</code>
                  </strong>
                  <small className="hint">{r.hint}</small>
                </div>
              </li>
            ))}
          </ul>
          <p className="hint">앱에 맞게 고치는 것은 워크스페이스 → 공통 서브플로우에서 합니다. 타깃을 더하면 그 타깃의 기본 파일도 생깁니다.</p>
        </>
      ) : null}
      {touched && props.problems.length > 0 ? (
        <ul className="checks" data-testid="first-app-problems">
          {props.problems.map((p) => (
            <li key={p} className="error">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {props.error ? (
        <p role="alert" className="error">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
