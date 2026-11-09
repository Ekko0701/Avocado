import type { RequestReviewResult, SubflowList } from "@qa/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/errors";
import { notifyWorkspaceChanged } from "../lib/workspace-events";

/**
 * 공통 서브플로우(flows/<앱>/<타깃>/common/*.yaml) 편집. 있는 파일만 고친다.
 * 저장하면 main 이 서브플로우 규약을 검사하고 그 앱의 앱 설정 작업 브랜치에 커밋한다. PR 작성은 앱 설정과 같다
 */
export function SubflowEditor(props: { apps: { app: string; name: string }[] }) {
  const [app, setApp] = useState(props.apps[0]?.app ?? "");
  const [list, setList] = useState<SubflowList | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [saved, setSaved] = useState<{ app: string; label: string; branch: string } | null>(null);
  const [pr, setPr] = useState<RequestReviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (target: string, keep: string | null) => {
    const next = await window.qa.workspace.subflows({ app: target });
    const pick = next.subflows.find((s) => s.path === keep) ?? next.subflows[0] ?? null;
    setList(next);
    setPath(pick?.path ?? null);
    setText(pick?.text ?? "");
  }, []);

  useEffect(() => {
    setList(null);
    setPr(null);
    setSaved(null);
    if (!app) return;
    load(app, null).catch((e: unknown) => setMessage(`서브플로우를 읽지 못했습니다: ${errorMessage(e)}`));
  }, [app, load]);

  const current = list?.subflows.find((s) => s.path === path) ?? null;
  const changed = current !== null && text !== current.text;
  const canSave = changed && !busy && summary.trim() !== "";

  function pick(next: string) {
    const found = list?.subflows.find((s) => s.path === next);
    setPath(next);
    setText(found?.text ?? "");
    setMessage(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current) return;
    setBusy(true);
    setMessage(null);
    setPr(null);
    try {
      const r = await window.qa.workspace.saveSubflow({ app, target: current.target, name: current.name, text, summary: summary.trim() });
      setSaved({ app, label: `${current.target}/common/${current.name}`, branch: r.branch });
      setMessage(`${r.branch} 에 커밋했습니다(${r.commit}).`);
      notifyWorkspaceChanged();
      await load(app, current.path);
    } catch (e) {
      setMessage(`저장 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    if (!saved) return;
    setBusy(true);
    setMessage(null);
    try {
      setPr(
        await window.qa.workspace.requestReview({
          title: `subflow: ${saved.app} ${saved.label} ${summary.trim()}`,
          body: `## 변경\n\n- 앱: ${saved.app}\n- 서브플로우: ${saved.label}\n- 요약: ${summary.trim()}\n- 이 서브플로우를 부르는 모든 플로우에 적용됩니다.\n`,
          branch: saved.branch,
        }),
      );
    } catch (e) {
      setMessage(`PR 작성 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" aria-label="공통 서브플로우" data-testid="subflows" onSubmit={(e) => void save(e)}>
      <h2>공통 서브플로우</h2>
      <p className="hint">
        플로우가 runFlow 로 부르는 공통 단계입니다(flows/&lt;앱&gt;/&lt;타깃&gt;/common/). 고치면 이 서브플로우를 부르는 모든 플로우에 적용됩니다. 저장하면 규약을 검사하고 그 앱의 앱 설정
        작업 브랜치에 커밋하며, PR 작성을 누르면 PR 을 만듭니다. 실행이나 플로우 만들기가 진행 중일 때는 저장하지 않습니다.
      </p>
      <div className="row">
        <label>
          앱
          <select aria-label="서브플로우 앱" value={app} onChange={(e) => setApp(e.target.value)}>
            {props.apps.map((a) => (
              <option key={a.app} value={a.app}>
                {a.name} ({a.app})
              </option>
            ))}
          </select>
        </label>
        {list && list.subflows.length > 0 ? (
          <label className="grow">
            파일
            <select aria-label="서브플로우 파일" value={path ?? ""} onChange={(e) => pick(e.target.value)}>
              {list.subflows.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.target}/common/{s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {list === null ? <p>불러오는 중</p> : null}
      {list && list.subflows.length === 0 ? <p className="hint">이 앱에는 공통 서브플로우가 없습니다.</p> : null}
      {list?.branch ? <small className="hint">진행 중인 앱 설정 브랜치 {list.branch} 에서 읽었습니다.</small> : null}
      {current ? (
        <>
          <small className="hint" data-testid="subflow-used-by">
            {current.usedBy.length > 0 ? `이 서브플로우를 부르는 플로우: ${current.usedBy.join(", ")}` : "이 서브플로우를 부르는 플로우가 없습니다."}
          </small>
          <textarea className="editor" aria-label="서브플로우 내용" value={text} onChange={(e) => setText(e.target.value)} rows={16} spellCheck={false} />
          <div className="row">
            <label className="grow">
              변경 요약
              <input aria-label="서브플로우 변경 요약" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={80} placeholder="예: wait for login button" />
            </label>
            <button type="submit" disabled={!canSave}>
              {busy ? "저장 중" : "저장(커밋)"}
            </button>
            {changed ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => setText(current.text)}>
                되돌리기
              </button>
            ) : null}
            {saved ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void review()}>
                PR 작성
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {message ? (
        <p role="status" data-testid="subflow-message">
          {message}
        </p>
      ) : null}
      {pr ? (
        <p role="status" className="ok-text" data-testid="subflow-pr">
          {pr.existing ? `열린 PR #${pr.number} 에 새 커밋을 올렸습니다: ` : `PR #${pr.number} 을 만들었습니다(${pr.branch}): `}
          <code>{pr.url}</code>
        </p>
      ) : null}
    </form>
  );
}
