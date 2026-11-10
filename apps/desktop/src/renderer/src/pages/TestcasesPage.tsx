import type { AuthorJob, RequestReviewResult, TestcaseHistory, TestcaseList, WorkBranchList, WorkspaceApp, WorkspaceStatus } from "@qa/shared";
import { lintTestcase, nextTestcaseId, parseTestcase, serializeTestcase, testcaseTemplate, type LintIssue, type Target, type TestcaseDoc } from "@qa/workspace/model";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { errorMessage, formatDateTime } from "../lib/errors";
import { notifyWorkspaceChanged, onWorkspaceChanged } from "../lib/workspace-events";

const STATUS_TEXT: Record<string, string> = { active: "사용", draft: "초안", deprecated: "폐기" };

/** 이 TC 로 플로우 만들기가 진행 중인가. 작업은 시작할 때 읽은 TC 로 플로우를 만든다 */
function authoringTc(job: AuthorJob | null, tc: { app: string; id: string } | null): boolean {
  return job !== null && tc !== null && (job.job.status === "queued" || job.job.status === "running") && job.app === tc.app && job.tcId === tc.id;
}
const ALL_TARGETS: Target[] = ["ios", "android", "flutter-ios", "flutter-android"];

/** 양식 편집 상태. 입력 중인 원래 글자(앞뒤 공백 포함)를 그대로 둔다 */
interface FormModel {
  title: string;
  status: "active" | "draft" | "deprecated";
  priority: "" | "high" | "medium" | "low";
  targets: Target[];
  tags: string;
  account: string;
  preconditions: string;
  steps: { action: string; expected: string }[];
  doneCriteria: string;
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function docToForm(doc: TestcaseDoc): FormModel {
  const fm = doc.frontMatter;
  return {
    title: fm.title,
    status: fm.status,
    priority: fm.priority ?? "",
    targets: fm.targets,
    tags: (fm.tags ?? []).join(", "),
    account: fm.account ?? "",
    preconditions: doc.preconditions.join("\n"),
    steps: doc.steps.map((s) => ({ action: s.action, expected: s.expected.join("\n") })),
    doneCriteria: doc.doneCriteria.join("\n"),
  };
}

function formToText(form: FormModel, base: { id: string; app: string }): string {
  return serializeTestcase({
    frontMatter: {
      id: base.id,
      app: base.app,
      title: form.title.trim() || "(제목 없음)",
      status: form.status,
      targets: form.targets.length ? form.targets : ["ios"],
      ...(form.priority ? { priority: form.priority } : {}),
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      ...(form.account ? { account: form.account } : {}),
    },
    preconditions: lines(form.preconditions),
    steps: form.steps.map((s) => ({ action: s.action.trim(), expected: lines(s.expected) })),
    doneCriteria: lines(form.doneCriteria),
  });
}

export function TestcasesPage() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [list, setList] = useState<TestcaseList | null>(null);
  const [filter, setFilter] = useState({ app: "", status: "", tag: "", q: "" });
  const [editing, setEditing] = useState<{ app: string; id: string; isNew: boolean } | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [form, setForm] = useState<FormModel | null>(null);
  const [summary, setSummary] = useState("");
  const [history, setHistory] = useState<TestcaseHistory | null>(null);
  const [newApp, setNewApp] = useState("");
  const [review, setReview] = useState({ title: "", body: "" });
  const [pr, setPr] = useState<RequestReviewResult | null>(null);
  const [branches, setBranches] = useState<WorkBranchList | null>(null);
  /** PR 을 만들 작업 브랜치. 비면 지금 브랜치 */
  const [reviewBranch, setReviewBranch] = useState("");
  /** 진행 중인(또는 마지막) 플로우 만들기. 그 TC 를 저장하면 경고한다 */
  const [authorJob, setAuthorJob] = useState<AuthorJob | null>(null);
  const [ackAuthoring, setAckAuthoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await window.qa.workspace.status();
    setStatus(s);
    setAuthorJob(await window.qa.agent.currentAuthor());
    if (s.connected) {
      setList(await window.qa.workspace.testcases());
      setBranches(await window.qa.workspace.branches());
    }
  }, []);
  useEffect(() => {
    refresh().catch((e: unknown) => setMessage(errorMessage(e)));
    // 툴바에서 동기화하면 목록·브랜치를 다시 읽는다
    return onWorkspaceChanged(() => void refresh().catch((e: unknown) => setMessage(errorMessage(e))));
  }, [refresh]);

  const appInfo: WorkspaceApp | undefined = list?.apps.find((a) => a.app === editing?.app);
  const lint = useMemo(
    () => (editing ? lintTestcase(text, { accountRoles: appInfo?.accountRoles ?? null, appTargets: appInfo?.targets ?? null }) : null),
    [text, editing, appInfo],
  );
  const errors = lint?.issues.filter((i) => i.level === "error") ?? [];
  const stepIssues = (i: number) => (lint?.issues ?? []).filter((x) => x.step === i);

  const tags = useMemo(() => [...new Set(list?.testcases.flatMap((t) => t.tags) ?? [])].sort(), [list]);
  const shown = (list?.testcases ?? []).filter(
    (t) =>
      (!filter.app || t.app === filter.app) &&
      (!filter.status || t.status === filter.status) &&
      (!filter.tag || t.tags.includes(filter.tag)) &&
      (!filter.q || `${t.id} ${t.title ?? ""}`.toLowerCase().includes(filter.q.toLowerCase())),
  );

  function startEditing(app: string, id: string, isNew: boolean, body: string) {
    setEditing({ app, id, isNew });
    setText(body);
    const parsed = parseTestcase(body);
    setForm(parsed.ok ? docToForm(parsed.doc) : null);
    setMode(parsed.ok ? "form" : "raw");
    setSummary(isNew ? `add ${id}` : "");
    setAckAuthoring(false);
    setMessage(null);
  }

  async function open(app: string, id: string) {
    try {
      const tc = await window.qa.workspace.readTestcase({ app, id });
      setAuthorJob(await window.qa.agent.currentAuthor());
      startEditing(app, id, false, tc.text);
      setHistory(await window.qa.workspace.history({ app, id }));
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  function createNew() {
    const app = list?.apps.find((a) => a.app === newApp) ?? list?.apps[0];
    if (!app || !list) return;
    const id = nextTestcaseId(list.testcases.map((t) => t.id));
    const targets = (app.targets.length ? app.targets : ["ios"]) as Target[];
    startEditing(app.app, id, true, testcaseTemplate({ id, app: app.app, targets, account: app.accountRoles[0] }));
    setHistory(null);
  }

  function updateForm(next: FormModel) {
    if (!editing) return;
    setForm(next);
    setText(formToText(next, editing));
  }

  function switchMode(next: "form" | "raw") {
    if (next === "form") {
      const parsed = parseTestcase(text);
      if (!parsed.ok) {
        setMessage("원문에 형식 오류가 있어 양식으로 볼 수 없습니다. 원문에서 고칩니다.");
        return;
      }
      setForm(docToForm(parsed.doc));
    }
    setMode(next);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setMessage(null);
    try {
      // 저장 직전에 다시 본다: 이 TC 로 플로우 만들기가 진행 중이면 경고를 확인해야 저장한다
      const current = await window.qa.agent.currentAuthor();
      setAuthorJob(current);
      if (authoringTc(current, editing) && !ackAuthoring) {
        setMessage("이 테스트 케이스로 플로우 만들기가 진행 중입니다. 아래 경고를 확인한 뒤 저장합니다.");
        return;
      }
      const r = await window.qa.workspace.saveTestcase({ app: editing.app, id: editing.id, text, summary: summary.trim() });
      setMessage(`${r.branch} 에 커밋했습니다(${r.commit})`);
      notifyWorkspaceChanged();
      setEditing({ ...editing, isNew: false });
      // 저장한 TC 의 작업 브랜치를 PR 작성 대상으로 둔다(다른 TC 의 브랜치였다면 제목도 새로)
      setReview((prev) =>
        prev.title && reviewBranch === r.branch ? prev : { title: `${editing.id} ${summary.trim()}`, body: `## 변경\n\n- 테스트 케이스: ${editing.id}\n- 요약: ${summary.trim()}\n` },
      );
      setReviewBranch(r.branch);
      setStatus(r.status);
      setList(await window.qa.workspace.testcases());
      setBranches(await window.qa.workspace.branches());
      setHistory(await window.qa.workspace.history({ app: editing.app, id: editing.id }));
    } catch (e) {
      setMessage(`저장 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function requestReview(event: FormEvent) {
    event.preventDefault();
    if (!reviewTarget) return;
    setBusy(true);
    setMessage(null);
    try {
      setPr(await window.qa.workspace.requestReview({ ...review, branch: reviewTarget.name }));
      await refresh();
    } catch (e) {
      setMessage(`PR 작성 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (status && !status.connected) {
    return (
      <div className="tc-page">
        <h1>테스트 케이스</h1>
        <p className="hint">워크스페이스를 먼저 연결합니다(메뉴 "워크스페이스").</p>
      </div>
    );
  }
  // 고른 작업 브랜치(없으면 지금 브랜치)에 main 에 없는 변경이 있으면 PR 작성 양식을 연다
  const reviewTarget = branches?.branches.find((b) => b.name === (reviewBranch || branches.current)) ?? null;
  const canReview = reviewTarget !== null && reviewTarget.pending && !(reviewTarget.current && (status?.dirty.length ?? 0) > 0);

  // 고른 작업 브랜치의 PR 작성 양식. 편집 중이면 편집 영역 맨 아래에, 아니면 오른쪽 칸에 카드로 둔다
  const reviewForm = (className: string) =>
    canReview ? (
      <form className={className} onSubmit={requestReview} aria-label="PR 작성">
        <h2>PR 작성</h2>
        <p className="hint" data-testid="tc-review-target">
          <code>{reviewTarget?.name}</code> 의 커밋 {reviewTarget?.ahead}개를 PR 로 올립니다. 이 브랜치의 열린 PR 이 있으면 그 PR 에 올립니다. 리뷰어가 머지하면 승인입니다.
        </p>
        <label>
          PR 제목
          <input value={review.title} onChange={(e) => setReview({ ...review, title: e.target.value })} required maxLength={200} />
        </label>
        <label>
          PR 본문
          <textarea value={review.body} onChange={(e) => setReview({ ...review, body: e.target.value })} rows={6} />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !review.title.trim()}>
            {busy ? "올리는 중" : "PR 올리기"}
          </button>
        </div>
      </form>
    ) : null;
  const prResult = pr ? (
    <p role="status" data-testid="tc-pr" className="ok-text">
      {pr.existing ? `열린 PR #${pr.number} 에 ${pr.branch} 의 새 커밋을 올렸습니다: ` : `PR #${pr.number} 을 만들었습니다(${pr.branch}): `}
      <code>{pr.url}</code>
    </p>
  ) : null;

  // 목록은 앱별로 묶는다. 아직 저장하지 않은 새 테스트 케이스도 그 앱 묶음 끝에 보인다
  const draft = editing?.isNew && !list?.testcases.some((t) => t.app === editing.app && t.id === editing.id) ? editing : null;
  const appIds = [...new Set([...(list?.apps.map((a) => a.app) ?? []), ...shown.map((t) => t.app)])];
  const groups = appIds
    .map((app) => ({ app, name: list?.apps.find((a) => a.app === app)?.name ?? app, rows: shown.filter((t) => t.app === app), draft: draft?.app === app ? draft : null }))
    .filter((g) => g.rows.length > 0 || g.draft !== null);

  return (
    <div className="tc-page">
      <div className="tc-head">
        <h1>테스트 케이스</h1>
        <select aria-label="새 테스트 케이스 앱" value={newApp} onChange={(e) => setNewApp(e.target.value)}>
          {list?.apps.map((a) => (
            <option key={a.app} value={a.app}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={!list?.apps.length} onClick={createNew}>
          새 테스트 케이스
        </button>
      </div>
      {message ? (
        <p role="status" data-testid="tc-message">
          {message}
        </p>
      ) : null}

      <div className="tc-panes">
        <section className="card tc-list-pane" aria-label="테스트 케이스 목록">
          <input aria-label="테스트 케이스 검색" placeholder="id·제목 검색" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <div className="tc-filters">
            <select aria-label="앱 필터" value={filter.app} onChange={(e) => setFilter({ ...filter, app: e.target.value })}>
              <option value="">모든 앱</option>
              {list?.apps.map((a) => (
                <option key={a.app} value={a.app}>
                  {a.name}
                </option>
              ))}
            </select>
            <select aria-label="상태 필터" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
              <option value="">모든 상태</option>
              {Object.entries(STATUS_TEXT).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select aria-label="태그 필터" value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })}>
              <option value="">모든 태그</option>
              {tags.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="tc-list">
            {groups.map((g) => (
              <section key={g.app} className="tc-group" aria-label={g.name}>
                <div className="tc-group-head">{g.name}</div>
                <ul>
                  {g.rows.map((t) => {
                    const selected = editing !== null && !editing.isNew && editing.app === t.app && editing.id === t.id;
                    return (
                      <li key={t.path} data-testid={`tc-${t.app}-${t.id}`}>
                        <button
                          type="button"
                          className={selected ? "tc-row active" : "tc-row"}
                          aria-current={selected ? "true" : undefined}
                          aria-label={`${t.app}/${t.id} ${t.title ?? "형식 오류"}`}
                          onClick={() => void open(t.app, t.id)}
                        >
                          <span className="tc-row-head">
                            <code>{t.id}</code>
                            {t.flows.length ? <span className="badge ok">플로우 {t.flows.join(", ")}</span> : <span className="badge">플로우 없음</span>}
                          </span>
                          <span>{t.title ?? <span className="error">형식 오류</span>}</span>
                          <span className="hint">{[t.status ? (STATUS_TEXT[t.status] ?? t.status) : null, t.targets.join(", "), t.tags.join(", ")].filter(Boolean).join(" · ")}</span>
                        </button>
                      </li>
                    );
                  })}
                  {g.draft ? (
                    <li data-testid={`tc-${g.draft.app}-${g.draft.id}`}>
                      <div className="tc-row active" aria-current="true">
                        <span className="tc-row-head">
                          <code>{g.draft.id}</code>
                          <span className="badge">새 테스트 케이스</span>
                        </span>
                        <span>{form?.title.trim() || "(제목 없음)"}</span>
                        <span className="hint">아직 저장하지 않았습니다</span>
                      </div>
                    </li>
                  ) : null}
                </ul>
              </section>
            ))}
            {list && groups.length === 0 ? <p className="hint tc-list-none">{list.testcases.length === 0 ? "아직 테스트 케이스가 없습니다." : "조건에 맞는 테스트 케이스가 없습니다."}</p> : null}
          </div>
          <p className="hint tc-list-foot">
            테스트 케이스 {shown.length}개 · 지금 브랜치 <code>{status?.branch ?? "-"}</code> 의 내용
          </p>
        </section>

        <div className="tc-detail">
          {editing ? (
            <section className="card tc-editor" data-testid="tc-editor">
              <div className="tc-editor-head">
                <h2>
                  {editing.app}/{editing.id} {editing.isNew ? <span className="badge">새 테스트 케이스</span> : null}
                </h2>
                <div className="row" role="tablist" aria-label="편집 방식">
                  <button type="button" role="tab" aria-selected={mode === "form"} className={mode === "form" ? "" : "secondary"} onClick={() => switchMode("form")}>
                    양식
                  </button>
                  <button type="button" role="tab" aria-selected={mode === "raw"} className={mode === "raw" ? "" : "secondary"} onClick={() => switchMode("raw")}>
                    원문
                  </button>
                </div>
              </div>
              <div className="tc-editor-body">
                <form id="tc-edit" className="stack" onSubmit={save} aria-label="테스트 케이스 편집">
                  {mode === "form" && form ? (
                    <div className="stack" data-testid="tc-form">
                      <label>
                        제목
                        <input value={form.title} onChange={(e) => updateForm({ ...form, title: e.target.value })} />
                      </label>
                      <div className="grid">
                        <label>
                          상태
                          <select value={form.status} onChange={(e) => updateForm({ ...form, status: e.target.value as FormModel["status"] })}>
                            {Object.entries(STATUS_TEXT).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          우선순위
                          <select value={form.priority} onChange={(e) => updateForm({ ...form, priority: e.target.value as FormModel["priority"] })}>
                            <option value="">없음</option>
                            <option value="high">high</option>
                            <option value="medium">medium</option>
                            <option value="low">low</option>
                          </select>
                        </label>
                        <label>
                          태그(쉼표로 구분)
                          <input value={form.tags} onChange={(e) => updateForm({ ...form, tags: e.target.value })} />
                        </label>
                        <label>
                          계정 역할
                          <select value={form.account} onChange={(e) => updateForm({ ...form, account: e.target.value })}>
                            <option value="">없음</option>
                            {[...new Set([...(appInfo?.accountRoles ?? []), ...(form.account ? [form.account] : [])])].map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <fieldset className="row">
                        <legend>타깃</legend>
                        {ALL_TARGETS.filter((t) => appInfo?.targets.includes(t) || form.targets.includes(t)).map((t) => (
                          <label key={t} className="check">
                            <input
                              type="checkbox"
                              checked={form.targets.includes(t)}
                              onChange={(e) => updateForm({ ...form, targets: e.target.checked ? [...form.targets, t] : form.targets.filter((x) => x !== t) })}
                            />
                            {t}
                          </label>
                        ))}
                      </fieldset>
                      <label>
                        전제조건(한 줄에 하나)
                        <textarea rows={3} value={form.preconditions} onChange={(e) => updateForm({ ...form, preconditions: e.target.value })} />
                      </label>
                      <div className="stack">
                        <strong>스텝</strong>
                        {form.steps.map((s, i) => (
                          <div key={i} className={stepIssues(i).some((x) => x.level === "error") ? "step-card bad" : "step-card"} data-testid={`tc-step-${i}`}>
                            <label>
                              {i + 1}. 동작
                              <input value={s.action} onChange={(e) => updateForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)) })} />
                            </label>
                            <label>
                              기대(한 줄에 하나)
                              <textarea rows={2} value={s.expected} onChange={(e) => updateForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)) })} />
                            </label>
                            <div className="row">
                              <button type="button" className="secondary" disabled={i === 0} onClick={() => updateForm({ ...form, steps: swap(form.steps, i, i - 1) })}>
                                위로
                              </button>
                              <button type="button" className="secondary" disabled={i === form.steps.length - 1} onClick={() => updateForm({ ...form, steps: swap(form.steps, i, i + 1) })}>
                                아래로
                              </button>
                              <button type="button" className="secondary" onClick={() => updateForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}>
                                스텝 삭제
                              </button>
                            </div>
                          </div>
                        ))}
                        <button type="button" className="secondary" onClick={() => updateForm({ ...form, steps: [...form.steps, { action: "", expected: "" }] })}>
                          스텝 추가
                        </button>
                      </div>
                      <label>
                        완료 기준(한 줄에 하나)
                        <textarea rows={2} value={form.doneCriteria} onChange={(e) => updateForm({ ...form, doneCriteria: e.target.value })} />
                      </label>
                    </div>
                  ) : (
                    <textarea className="editor" aria-label="테스트 케이스 원문" value={text} onChange={(e) => setText(e.target.value)} rows={24} spellCheck={false} />
                  )}
                </form>
                {history && history.length > 0 ? (
                  <details>
                    <summary>변경 내역 {history.length}개</summary>
                    <ul className="matches" data-testid="tc-history">
                      {history.map((h) => (
                        <li key={h.commit}>
                          <code>{h.commit}</code> {formatDateTime(h.date)} · {h.author} · {h.subject}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {reviewForm("tc-review")}
                {prResult}
              </div>
              <div className="tc-editor-foot">
                <LintPanel issues={lint?.issues ?? []} />
                {authoringTc(authorJob, editing) ? (
                  <div role="alert" className="warning stack" data-testid="tc-authoring-warning">
                    <p>
                      이 테스트 케이스로 플로우 만들기가 진행 중입니다({authorJob?.target}). 작업은 시작할 때 읽은 테스트 케이스로 플로우를 만들어서, 지금 저장하는 변경은 그 플로우에 반영되지
                      않습니다. 끝난 뒤 저장하거나, 플로우 만들기에서 작업을 취소하고 저장한 뒤 다시 시작합니다.
                    </p>
                    <label className="row">
                      <input type="checkbox" checked={ackAuthoring} onChange={(e) => setAckAuthoring(e.target.checked)} />
                      진행 중인 플로우 만들기에 반영되지 않는 것을 알고 저장합니다
                    </label>
                  </div>
                ) : null}
                <div className="row">
                  <label className="grow">
                    변경 요약
                    <input form="tc-edit" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={80} placeholder="예: signup expected text" />
                  </label>
                  <button type="submit" form="tc-edit" disabled={busy || !summary.trim() || errors.length > 0}>
                    {busy ? "저장 중" : "저장(커밋)"}
                  </button>
                </div>
                {errors.length > 0 ? <small className="error">차단 항목 {errors.length}개를 고쳐야 저장할 수 있습니다.</small> : null}
              </div>
            </section>
          ) : (
            <div className="tc-idle">
              <section className="card tc-empty" data-testid="tc-empty">
                <Icon name="doc" size={30} />
                <strong>테스트 케이스를 고르세요</strong>
                <p className="hint">왼쪽 목록에서 고르거나 위의 새 테스트 케이스로 만듭니다.</p>
              </section>
              {reviewForm("card stack")}
              {prResult}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function swap<T>(items: T[], a: number, b: number): T[] {
  const next = [...items];
  const x = next[a];
  const y = next[b];
  if (x === undefined || y === undefined) return items;
  next[a] = y;
  next[b] = x;
  return next;
}

function LintPanel({ issues }: { issues: LintIssue[] }) {
  if (issues.length === 0) return <p className="ok-text" data-testid="tc-lint">린트 문제 없음</p>;
  return (
    <ul className="checks" data-testid="tc-lint" aria-label="린트">
      {issues.map((i, n) => (
        <li key={n} className="check">
          <span className={i.level === "error" ? "badge bad" : "badge"}>{i.level === "error" ? "차단" : "경고"}</span>
          <div className="check-body">{i.message}</div>
        </li>
      ))}
    </ul>
  );
}
