import type { QaWatchApp, QaWatchSettings, QaWatchState } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage, formatDateTime } from "../lib/errors";

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const newApp = (): QaWatchApp => ({ id: crypto.randomUUID(), app: "", project: "", tag: "", scope: "assigned_to_me", repoPath: "", enabled: true });

/**
 * QA 티켓 자동 처리 설정(사이드 브랜치). 어느 프로젝트의 어떤 태그를 언제 볼지, 사람 확인 없이 무엇까지 해도 되는지 정한다.
 * Avocado 는 이슈 트래커를 직접 조회하지 않는다. 주기적으로 깨어난 Claude Code 가 이 설정을 받아 간다.
 */
export function QaWatchPanel() {
  const [state, setState] = useState<QaWatchState | null>(null);
  const [draft, setDraft] = useState<QaWatchSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    window.qa.qawatch.get().then(
      (s) => {
        setState(s);
        setDraft(s.settings);
      },
      (e: unknown) => setMessage({ text: errorMessage(e), error: true }),
    );
  }, []);

  if (!draft) return message ? <p className="error">{message.text}</p> : null;

  const patch = (over: Partial<QaWatchSettings>) => setDraft({ ...draft, ...over });
  const patchApp = (id: string, over: Partial<QaWatchApp>) => patch({ apps: draft.apps.map((a) => (a.id === id ? { ...a, ...over } : a)) });
  const dirty = JSON.stringify(draft) !== JSON.stringify(state?.settings);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await window.qa.qawatch.save(draft);
      setState(saved);
      setDraft(saved.settings);
      setMessage({ text: "저장했습니다", error: false });
    } catch (e) {
      const text = errorMessage(e);
      setMessage({ text: text.includes("invalid-input") ? "입력 형식이 맞지 않습니다. 앱 이름은 소문자·숫자·하이픈이고, 프로젝트·태그·저장소 폴더는 비울 수 없습니다." : text, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder(id: string) {
    try {
      const path = await window.qa.qawatch.pickFolder();
      if (path) patchApp(id, { repoPath: path });
    } catch (e) {
      setMessage({ text: errorMessage(e), error: true });
    }
  }

  return (
    <section className="card stack" aria-label="자동 처리 설정">
      <h2>자동 처리 설정</h2>
      <p className="hint">
        정한 태그가 붙은 티켓이 올라오면 Claude Code 가 알아서 처리합니다. 여기서는 무엇을 언제 볼지만 정합니다. 실제 확인은 Claude Code 의 예약 작업이 하고, 이 Mac 과 Claude
        앱이 켜져 있을 때만 돕니다.
      </p>
      <label className="row">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> 자동 처리 켜기
      </label>
      <div className="row">
        <label>
          확인 간격(분)
          <input type="number" min={5} max={1440} value={draft.intervalMinutes} onChange={(e) => patch({ intervalMinutes: Number(e.target.value) })} />
        </label>
        <label>
          시작 시
          <input type="number" min={0} max={23} value={draft.startHour} onChange={(e) => patch({ startHour: Number(e.target.value) })} />
        </label>
        <label>
          끝 시
          <input type="number" min={1} max={24} value={draft.endHour} onChange={(e) => patch({ endHour: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row" role="group" aria-label="확인하는 요일">
        {DAYS.map((name, day) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={draft.days.includes(day)}
              onChange={(e) => patch({ days: e.target.checked ? [...draft.days, day].sort() : draft.days.filter((d) => d !== day) })}
            />{" "}
            {name}
          </label>
        ))}
      </div>
      <label className="row">
        <input type="checkbox" checked={draft.autoMr} onChange={(e) => patch({ autoMr: e.target.checked })} /> 사람 확인 없이 MR 올리기
      </label>
      <label className="row">
        <input type="checkbox" checked={draft.autoComment} onChange={(e) => patch({ autoComment: e.target.checked })} /> 사람 확인 없이 티켓에 댓글 달기
      </label>
      {!draft.autoMr ? <p className="hint">MR 올리기를 꺼 두면 수정과 기기 확인까지만 하고 멈춥니다. 작업 브랜치는 남습니다.</p> : null}

      <h3>감시 항목</h3>
      {draft.apps.length === 0 ? <p className="hint">감시 항목이 없습니다.</p> : null}
      {draft.apps.map((a) => (
        <div key={a.id} className="card stack" data-testid={`qawatch-app-${a.id}`}>
          <div className="row">
            <label>
              앱 이름
              <input aria-label="앱 이름" value={a.app} placeholder="demo" onChange={(e) => patchApp(a.id, { app: e.target.value })} />
            </label>
            <label>
              프로젝트
              <input aria-label="프로젝트" value={a.project} placeholder="앱-QA" onChange={(e) => patchApp(a.id, { project: e.target.value })} />
            </label>
            <label>
              태그
              <input aria-label="태그" value={a.tag} onChange={(e) => patchApp(a.id, { tag: e.target.value })} />
            </label>
            <label>
              대상
              <select aria-label="대상" value={a.scope} onChange={(e) => patchApp(a.id, { scope: e.target.value === "all" ? "all" : "assigned_to_me" })}>
                <option value="assigned_to_me">나에게 배정된 것만</option>
                <option value="all">태그가 붙은 것 전부</option>
              </select>
            </label>
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={() => void pickFolder(a.id)}>
              저장소 폴더 선택
            </button>
            {a.repoPath ? <code>{a.repoPath}</code> : <span className="hint">고칠 코드가 있는 폴더를 고릅니다</span>}
          </div>
          <div className="row">
            <label>
              <input type="checkbox" checked={a.enabled} onChange={(e) => patchApp(a.id, { enabled: e.target.checked })} /> 이 항목 켜기
            </label>
            <button type="button" className="secondary" onClick={() => patch({ apps: draft.apps.filter((x) => x.id !== a.id) })}>
              항목 삭제
            </button>
          </div>
        </div>
      ))}
      <div className="row">
        <button type="button" className="secondary" onClick={() => patch({ apps: [...draft.apps, newApp()] })}>
          감시 항목 추가
        </button>
        <button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "저장 중" : "저장"}
        </button>
        <small className="hint">{state?.lastCheckedAt ? `마지막 확인 ${formatDateTime(state.lastCheckedAt)}` : "아직 확인한 적 없음"}</small>
      </div>
      {message ? (
        <p className={message.error ? "error" : undefined} role="status" data-testid="qawatch-message">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
