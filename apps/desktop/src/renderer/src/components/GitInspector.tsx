import type { MyPullRequest, RequestReviewResult, WorkBranch, WorkBranchList, WorkspaceStatus } from "@qa/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";
import { branchTarget, defaultReview, groupGitWork } from "../lib/git-state";
import { notifyWorkspaceChanged, onWorkspaceChanged } from "../lib/workspace-events";
import { Icon, type IconName } from "./Icon";

/**
 * Git 상태 인스펙터(툴바의 "Git 상태" 버튼으로 여닫는 오른쪽 판). 진행 중인 작업을 종류별로 보인다:
 * 저장 안 한 변경, PR 을 올리지 않은 커밋(작업 브랜치), 열린 PR, main 에 반영된 브랜치.
 * 브랜치 바꾸기(체크아웃)와 PR 작성을 여기서 한다. 다른 화면이 저장·동기화하면 다시 읽는다
 */
export function GitInspector(props: { onClose: () => void }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [branches, setBranches] = useState<WorkBranchList | null>(null);
  /** 내 열린 PR. 읽지 못했으면 null 이고 pullsError 에 이유를 둔다 */
  const [pulls, setPulls] = useState<MyPullRequest[] | null>(null);
  const [pullsError, setPullsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** PR 작성 양식을 펼친 작업 브랜치 */
  const [reviewFor, setReviewFor] = useState<string | null>(null);
  const [review, setReview] = useState({ title: "", body: "" });
  const [pr, setPr] = useState<RequestReviewResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await window.qa.workspace.status();
      setStatus(s);
      setError(null);
      if (!s.connected) {
        setBranches(null);
        setPulls(null);
        setPullsError(null);
        return;
      }
      setBranches(await window.qa.workspace.branches());
      // PR 목록은 GitHub 에서 읽는다. 못 읽어도 브랜치는 보인다
      await window.qa.workspace.myPulls().then(
        (list) => {
          setPulls(list);
          setPullsError(null);
        },
        (e: unknown) => {
          setPulls(null);
          setPullsError(errorMessage(e));
        },
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 이 판이 방금 다시 읽고 알린 변경이면 한 번 더 읽지 않는다 */
  const ownChange = useRef(false);
  useEffect(() => {
    void refresh();
    const off = onWorkspaceChanged(() => {
      if (ownChange.current) ownChange.current = false;
      else void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  /** 바꾼 뒤 목록을 다시 읽고 나서 다른 화면에 알린다(브랜치·PR 목록이 요약보다 늦게 바뀌어 보이지 않게) */
  async function reloadAndNotify() {
    await refresh();
    ownChange.current = true;
    notifyWorkspaceChanged();
  }

  async function checkout(branch: string) {
    setBusy(true);
    setMessage(null);
    setError(null);
    setPr(null);
    try {
      await window.qa.workspace.checkout({ branch });
      await reloadAndNotify();
      setMessage(`${branch} 로 체크아웃했습니다`);
    } catch (e) {
      setError(`브랜치를 바꾸지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function startReview(b: WorkBranch) {
    setReviewFor(b.name);
    setReview(defaultReview(b));
    setPr(null);
    setMessage(null);
  }

  async function requestReview(event: FormEvent) {
    event.preventDefault();
    if (!reviewFor) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const created = await window.qa.workspace.requestReview({ ...review, branch: reviewFor });
      await reloadAndNotify();
      setPr(created);
      setReviewFor(null);
    } catch (e) {
      setError(`PR 작성 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const work = groupGitWork(branches?.branches ?? [], pulls);
  const dirty = status?.dirty ?? [];
  const nothing = dirty.length === 0 && work.unpublished.length === 0 && work.open.length === 0 && pullsError === null;

  return (
    <aside className="inspector glass" aria-label="Git 상태" data-testid="git-inspector">
      <div className="inspector-head">
        <h2>Git 상태</h2>
        <button type="button" className="tool" aria-label="Git 상태 새로 고침" disabled={busy} onClick={() => void refresh()}>
          <Icon name="sync" size={15} />
        </button>
        <button type="button" className="tool" aria-label="Git 상태 닫기" onClick={props.onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>

      {status?.connected ? (
        <div className="inspector-summary" data-testid="git-summary">
          <div className="inspector-summary-branch">
            <Icon name="branch" size={14} />
            <span className="inspector-ellipsis">{status.branch}</span>
            <span className="badge">지금 브랜치</span>
          </div>
          <div className="hint">
            {status.repo} · {syncText(status)}
          </div>
          {status.onMain ? null : (
            <div className="inspector-actions">
              <button type="button" className="secondary small" disabled={busy} onClick={() => void checkout("main")}>
                main 으로 돌아가기
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="inspector-body">
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="ok-text" data-testid="git-message">
            {message}
          </p>
        ) : null}
        {pr ? (
          <p role="status" className="ok-text" data-testid="git-pr">
            {pr.existing ? `열린 PR #${pr.number} 에 새 커밋을 올렸습니다` : `PR #${pr.number} 을 만들었습니다`}
            <br />
            <code>{pr.branch}</code>
          </p>
        ) : null}

        {loading ? <p className="hint">불러오는 중</p> : null}
        {!loading && status && !status.connected ? <p className="hint">워크스페이스를 먼저 연결합니다(메뉴 "워크스페이스").</p> : null}

        {status?.connected && branches ? (
          <>
            {dirty.length > 0 ? (
              <Section label="저장 안 한 변경" icon="doc" count={dirty.length} testId="git-dirty">
                {dirty.map((path) => (
                  <li key={path} className="inspector-item inline">
                    <code className="inspector-ellipsis">{path}</code>
                    <span className="badge">커밋 전</span>
                  </li>
                ))}
              </Section>
            ) : null}

            {work.unpublished.length > 0 ? (
              <Section label="커밋 · PR 을 올리지 않음" icon="commit" count={work.unpublished.length} testId="git-commits">
                {work.unpublished.map((b) => (
                  <li key={b.name} className="inspector-item" data-testid={`git-branch-${b.name}`}>
                    <div className="inspector-item-head">
                      <span className="badge">{branchTarget(b)}</span>
                      {b.current ? <span className="badge ok">지금</span> : null}
                      <span className="hint">커밋 {b.ahead}개</span>
                    </div>
                    <strong>{b.subject}</strong>
                    <code className="inspector-branch">{b.name}</code>
                    {reviewFor === b.name ? (
                      <form className="inspector-form" aria-label="PR 작성" onSubmit={requestReview}>
                        <p className="hint">
                          커밋 {b.ahead}개를 PR 로 올립니다. 리뷰어가 머지하면 승인입니다.
                          {b.current && dirty.length > 0 ? " 저장 안 한 변경은 올라가지 않습니다." : ""}
                        </p>
                        <label>
                          PR 제목
                          <input value={review.title} onChange={(e) => setReview({ ...review, title: e.target.value })} required maxLength={200} />
                        </label>
                        <label>
                          PR 본문
                          <textarea value={review.body} onChange={(e) => setReview({ ...review, body: e.target.value })} rows={4} />
                        </label>
                        <div className="inspector-actions">
                          <button type="submit" className="small" disabled={busy || !review.title.trim()}>
                            {busy ? "올리는 중" : "PR 올리기"}
                          </button>
                          <button type="button" className="secondary small" disabled={busy} onClick={() => setReviewFor(null)}>
                            취소
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="inspector-actions">
                        <button type="button" className="small" disabled={busy} onClick={() => startReview(b)}>
                          PR 작성
                        </button>
                        {b.current ? null : (
                          <button type="button" className="secondary small" disabled={busy} onClick={() => void checkout(b.name)}>
                            체크아웃
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </Section>
            ) : null}

            {work.open.length > 0 ? (
              <Section label="열린 PR" icon="pull" count={work.open.length} testId="git-pulls">
                {work.open.map(({ pull, branch }) => (
                  <li key={pull.number} className="inspector-item" data-testid={`git-pull-${pull.number}`}>
                    <div className="inspector-item-head">
                      <span className="badge ok">PR #{pull.number} · 열림</span>
                      {branch?.current ? <span className="badge ok">지금</span> : null}
                      <span className="hint">{uploadedOn(pull.createdAt)}</span>
                    </div>
                    <strong>{pull.title}</strong>
                    <code className="inspector-branch">{pull.branch}</code>
                    <div className="inspector-actions">
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => void window.qa.app.openExternal({ url: pull.url }).catch((e: unknown) => setError(errorMessage(e)))}
                      >
                        GitHub 에서 열기
                      </button>
                      {branch && !branch.current ? (
                        <button type="button" className="secondary small" disabled={busy} onClick={() => void checkout(branch.name)}>
                          체크아웃
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </Section>
            ) : null}
            {pullsError ? (
              <p role="alert" className="warning">
                열린 PR 을 읽지 못했습니다: {pullsError}
              </p>
            ) : null}

            {nothing ? (
              <div className="inspector-empty" data-testid="git-empty">
                <Icon name="check" size={28} />
                <strong>진행 중인 작업이 없습니다</strong>
                <p className="hint">테스트 케이스를 저장하거나 플로우를 만들면 커밋이 여기에 보입니다.</p>
              </div>
            ) : null}

            {work.merged.length > 0 ? (
              <details className="inspector-merged" data-testid="git-merged">
                <summary>
                  <Icon name="check" size={13} />
                  <span>main 에 반영됨</span>
                  <span className="inspector-count">{work.merged.length}</span>
                </summary>
                <ul className="inspector-list">
                  {work.merged.map((b) => (
                    <li key={b.name} className="inspector-merged-row">
                      <code className="inspector-ellipsis">{b.name}</code>
                      {b.current ? (
                        <span className="badge ok">지금</span>
                      ) : (
                        <button type="button" className="link" disabled={busy} onClick={() => void checkout(b.name)}>
                          체크아웃
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function Section(props: { label: string; icon: IconName; count: number; testId: string; children: ReactNode }) {
  return (
    <section className="inspector-section" aria-label={props.label} data-testid={props.testId}>
      <div className="inspector-section-head">
        <Icon name={props.icon} size={13} />
        <span>{props.label}</span>
        <span className="inspector-count">{props.count}</span>
      </div>
      <ul className="inspector-list">{props.children}</ul>
    </section>
  );
}

/** 지금 브랜치가 원격 main 과 얼마나 다른가(툴바의 ↑↓ 와 같은 값) */
function syncText(s: WorkspaceStatus): string {
  const parts: string[] = [];
  if (s.ahead > 0) parts.push(`main 보다 커밋 ${s.ahead}개 앞`);
  if (s.behind > 0) parts.push(`받지 않은 커밋 ${s.behind}개`);
  return parts.length > 0 ? parts.join(" · ") : "원격 main 과 같습니다";
}

function uploadedOn(iso: string): string {
  return `${new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })} 올림`;
}
