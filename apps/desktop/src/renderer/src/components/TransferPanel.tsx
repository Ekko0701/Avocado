import type { ArchiveProblem, ExportInfo, ImportApplyResult, ImportPreview, ImportSource, RequestReviewResult, TransferAction, TransferItem } from "@qa/shared";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";
import { actionLabel, defaultImportReview, idRanges, importedSummary, initialPicks, lineDiff, picksToApply, PROBLEM_BADGE, requiredBy, shortName, STATUS_BADGE, summaryText, type PickState } from "../lib/transfer";
import { notifyWorkspaceChanged } from "../lib/workspace-events";

type ImportState =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "preview"; preview: ImportPreview; picks: PickState; from: ImportSource }
  | { step: "rejected"; sourceLabel: string; problems: ArchiveProblem[]; from: ImportSource }
  | { step: "applying"; preview: ImportPreview; picks: PickState; from: ImportSource }
  | { step: "done"; preview: ImportPreview; picked: { key: string; action: TransferAction }[]; result: ImportApplyResult };

const LOCAL_SOURCE = "이 Mac 의 로컬 워크스페이스";

/**
 * 워크스페이스 내보내기·가져오기(ADR 0036 결정 11). 내보내기는 zip 하나, 가져오기는 받은 zip·폴더(GitHub 방식은 이 Mac 의 로컬 워크스페이스도)를
 * 이 워크스페이스와 견준 미리보기에서 고른 항목만 쓴다. 파일 경로는 main 이 연 창에서만 정한다
 */
export function TransferPanel(props: { local: boolean }) {
  const [tab, setTab] = useState<"export" | "import">("export");
  return (
    <section className="card ws-detail transfer" aria-label="내보내기·가져오기" data-testid="transfer">
      <div className="ws-head">
        <div className="ws-head-title">
          <h2>{tab === "export" ? "내보내기" : "가져오기"}</h2>
          <div className="row" role="tablist" aria-label="내보내기 또는 가져오기">
            <button type="button" role="tab" aria-selected={tab === "export"} className={tab === "export" ? "" : "secondary"} onClick={() => setTab("export")}>
              내보내기
            </button>
            <button type="button" role="tab" aria-selected={tab === "import"} className={tab === "import" ? "" : "secondary"} onClick={() => setTab("import")}>
              가져오기
            </button>
          </div>
        </div>
      </div>
      {tab === "export" ? <ExportTab local={props.local} /> : <ImportTab local={props.local} />}
    </section>
  );
}

function ExportTab(props: { local: boolean }) {
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    window.qa.workspace.exportInfo().then(setInfo, (e: unknown) => setMessage(`내보낼 내용을 읽지 못했습니다: ${errorMessage(e)}`));
  }, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await window.qa.workspace.export();
      if (r) setSaved(r.path);
    } catch (e) {
      setMessage(`내보내기 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ws-head transfer-sub">
        <small className="hint">
          테스트 케이스·플로우·앱 설정·공통 서브플로우를 zip 하나로 저장합니다. 받는 사람은 워크스페이스 → 내보내기·가져오기에서 엽니다.
          {props.local ? "" : " GitHub 워크스페이스의 main 을 내보냅니다. 작업 브랜치의 아직 머지하지 않은 수정은 들어가지 않습니다."}
        </small>
      </div>
      <div className="ws-body">
        <strong className="group-label">들어가는 것</strong>
        <ul className="checks" data-testid="export-includes">
          <li className="check">
            <span className="badge ok">앱 {info?.apps ?? "-"}개</span>
            <div className="check-body">
              <strong>앱 설정</strong>
              <small className="hint">{info && info.appNames.length ? `${info.appNames.join(", ")} 의 app.yaml 과 accounts.yaml(계정 역할과 키 이름)` : "등록한 앱이 없습니다"}</small>
            </div>
          </li>
          <li className="check">
            <span className="badge ok">{info?.testcases ?? "-"}개</span>
            <div className="check-body">
              <strong>테스트 케이스</strong>
              <small className="hint">{info && info.testcaseIds.length ? idRanges(info.testcaseIds) : "없음"}</small>
            </div>
          </li>
          <li className="check">
            <span className="badge ok">{info?.flows ?? "-"}개</span>
            <div className="check-body">
              <strong>플로우</strong>
              <small className="hint">플로우 파일과 플로우 정보(meta)</small>
            </div>
          </li>
          <li className="check">
            <span className="badge ok">{info?.subflows ?? "-"}개</span>
            <div className="check-body">
              <strong>공통 서브플로우</strong>
              <small className="hint">앱·타깃마다 common 폴더의 파일</small>
            </div>
          </li>
        </ul>
        <strong className="group-label">들어가지 않는 것</strong>
        <ul className="checks">
          <li className="check">
            <span className="badge">값</span>
            <div className="check-body">
              <strong>테스트 계정 값</strong>
              <small className="hint">키 이름만 들어갑니다. 받는 사람이 자기 Mac 의 테스트 계정 화면에서 넣습니다</small>
            </div>
          </li>
          <li className="check">
            <span className="badge">증적</span>
            <div className="check-body">
              <strong>실행 기록과 증적</strong>
              <small className="hint">증적은 결과 화면의 폴더로 내보내기로 건넵니다</small>
            </div>
          </li>
          <li className="check">
            <span className="badge">빌드</span>
            <div className="check-body">
              <strong>등록한 빌드</strong>
              <small className="hint">빌드는 각자 등록합니다</small>
            </div>
          </li>
        </ul>
        <div role="note" className="transfer-note">
          <strong>알아 둘 것</strong>
          <span>플로우 정보(meta)에 플로우를 만들 때 쓴 기기 이름과 빌드 번호가 들어 있습니다. 다른 정보는 들어가지 않습니다.</span>
        </div>
        {message ? (
          <p role="alert" className="error">
            {message}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="ok-text" data-testid="export-saved">
            저장했습니다: <code>{saved}</code>
          </p>
        ) : null}
      </div>
      <div className="ws-foot">
        <div className="row">
          <span className="hint grow">
            파일 이름 <code>{info?.fileName ?? "-"}</code>
          </span>
          <button type="button" disabled={busy || info === null} onClick={() => void save()}>
            {busy ? "저장 중" : "zip 으로 저장…"}
          </button>
        </div>
      </div>
    </>
  );
}

function ImportTab(props: { local: boolean }) {
  const [state, setState] = useState<ImportState>({ step: "idle" });
  const [source, setSource] = useState<"local-workspace" | "pick">(props.local ? "pick" : "local-workspace");
  const [message, setMessage] = useState<string | null>(null);

  async function pick(from: ImportSource) {
    setMessage(null);
    if (state.step === "preview") void window.qa.workspace.importCancel({ importId: state.preview.importId }).catch(() => undefined);
    setState({ step: "reading" });
    try {
      const r = await window.qa.workspace.importPick({ from });
      if (r.status === "canceled") setState({ step: "idle" });
      else if (r.status === "rejected") setState({ step: "rejected", sourceLabel: r.sourceLabel, problems: r.problems, from });
      else setState({ step: "preview", preview: r.preview, picks: initialPicks(r.preview.items), from });
    } catch (e) {
      setMessage(`가져올 곳을 읽지 못했습니다: ${errorMessage(e)}`);
      setState({ step: "idle" });
    }
  }

  async function cancel() {
    if (state.step === "preview") await window.qa.workspace.importCancel({ importId: state.preview.importId }).catch(() => undefined);
    setMessage(null);
    setState({ step: "idle" });
  }

  async function apply() {
    if (state.step !== "preview") return;
    const picked = picksToApply(state.preview.items, state.picks);
    setMessage(null);
    setState({ ...state, step: "applying" });
    try {
      const result = await window.qa.workspace.importApply({ importId: state.preview.importId, picks: picked });
      notifyWorkspaceChanged();
      setState({ step: "done", preview: state.preview, picked, result });
    } catch (e) {
      setMessage(`가져오기 실패: ${errorMessage(e)}`);
      setState({ ...state, step: "preview" });
    }
  }

  const pickButtons = (
    <>
      <button type="button" className="secondary small" onClick={() => void pick("file")}>
        zip 고르기…
      </button>
      <button type="button" className="secondary small" onClick={() => void pick("folder")}>
        폴더 고르기…
      </button>
    </>
  );
  const chooser = props.local ? (
    <div className="row transfer-source">{pickButtons}</div>
  ) : (
    <div className="row transfer-source">
      <span className="hint">가져올 곳</span>
      <select aria-label="가져올 곳" value={source} onChange={(e) => setSource(e.target.value === "pick" ? "pick" : "local-workspace")}>
        <option value="local-workspace">{LOCAL_SOURCE}</option>
        <option value="pick">zip 이나 폴더 고르기…</option>
      </select>
      {source === "local-workspace" ? (
        <button type="button" className="secondary small" onClick={() => void pick("local-workspace")}>
          견주어 보기
        </button>
      ) : (
        pickButtons
      )}
      <span className="hint">main 과 견줍니다. 지금 작업 폴더와 브랜치는 바뀌지 않습니다.</span>
    </div>
  );

  const intro = props.local
    ? "받은 zip 이나 폴더를 이 워크스페이스와 견주어 보고, 고른 항목만 가져옵니다. 받은 플로우는 이 Mac 의 플로우 검사를 통과한 것만 씁니다."
    : "로컬 워크스페이스나 받은 zip 의 항목을 가져와 PR 로 올립니다. 가져올 때마다 새 브랜치를 만듭니다.";

  return (
    <>
      <div className="ws-head transfer-sub">
        <small className="hint">{intro}</small>
      </div>
      {state.step === "idle" || state.step === "reading" ? (
        <div className="ws-body">
          {chooser}
          {state.step === "reading" ? (
            <p role="status" className="hint">
              읽고 검사하는 중입니다. 플로우마다 Maestro 문법 검사를 해서 조금 걸립니다.
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="error" data-testid="import-message">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
      {state.step === "rejected" ? <Rejected state={state} onPick={() => void pick(state.from)} local={props.local} /> : null}
      {state.step === "preview" || state.step === "applying" ? (
        <Preview
          preview={state.preview}
          picks={state.picks}
          busy={state.step === "applying"}
          local={props.local}
          message={message}
          chooser={
            state.from === "local-workspace" ? null : (
              <button type="button" className="secondary small" disabled={state.step === "applying"} onClick={() => void pick(state.from)}>
                다른 {state.from === "folder" ? "폴더" : "파일"} 고르기
              </button>
            )
          }
          onPicks={(picks) => state.step === "preview" && setState({ ...state, picks })}
          onCancel={() => void cancel()}
          onApply={() => void apply()}
        />
      ) : null}
      {state.step === "done" ? <Done state={state} onAgain={() => setState({ step: "idle" })} /> : null}
    </>
  );
}

function Rejected(props: { state: Extract<ImportState, { step: "rejected" }>; onPick: () => void; local: boolean }) {
  const { state } = props;
  const where = state.from === "folder" ? "이 폴더에" : state.from === "file" ? "이 zip 에" : "로컬 워크스페이스에";
  return (
    <>
      <div className="ws-body" data-testid="import-rejected">
        <div role="alert" className="transfer-note">
          <strong>{state.sourceLabel} 은 가져오지 않았습니다</strong>
          <span>{where} 워크스페이스 파일로 받을 수 없는 항목이 있어 전체를 거절했습니다. 이 Mac 에는 아무것도 쓰지 않았습니다.</span>
        </div>
        <strong className="group-label">거절한 이유</strong>
        <ul className="checks">
          {state.problems.map((p, i) => (
            <li key={`${p.path}:${p.code}:${i}`} className="check">
              <span className="badge bad">{PROBLEM_BADGE[p.code]}</span>
              <div className="check-body">
                <strong>{p.path || "(전체)"}</strong>
                <small className="hint">{p.message}</small>
              </div>
            </li>
          ))}
        </ul>
        <small className="hint">보낸 사람에게 Avocado 의 내보내기로 다시 만들어 달라고 하면 이런 항목이 들어가지 않습니다.</small>
      </div>
      <div className="ws-foot">
        <div className="row">
          <span className="grow" />
          {state.from === "local-workspace" ? null : (
            <button type="button" onClick={props.onPick}>
              다른 {state.from === "folder" ? "폴더" : "파일"} 고르기
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Preview(props: {
  preview: ImportPreview;
  picks: PickState;
  busy: boolean;
  local: boolean;
  message: string | null;
  chooser: ReactNode;
  onPicks: (picks: PickState) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { preview, picks } = props;
  const [comparing, setComparing] = useState<string | null>(null);
  const required = useMemo(() => requiredBy(preview.items, picks), [preview.items, picks]);
  const count = picksToApply(preview.items, picks).length;
  const set = (key: string, next: Partial<PickState[string]>) => {
    const current = picks[key];
    if (current) props.onPicks({ ...picks, [key]: { ...current, ...next } });
  };

  return (
    <>
      <div className="ws-body" data-testid="import-preview">
        <div className="row transfer-source">
          <strong>{preview.sourceLabel}</strong>
          <span className="hint">{summaryText(preview)}</span>
          <span className="grow" />
          {props.chooser}
        </div>
        <table className="matrix transfer-table">
          <thead>
            <tr>
              <th className="transfer-pick">
                <span className="hint">고름</span>
              </th>
              <th>항목</th>
              <th>상태</th>
              <th>가져오면</th>
            </tr>
          </thead>
          <tbody>
            {preview.items.map((item) => (
              <PreviewRow key={item.key} item={item} pick={picks[item.key]} requiredBy={required.get(item.key) ?? null} comparing={comparing === item.key} disabled={props.busy} onCompare={() => setComparing(comparing === item.key ? null : item.key)} onPick={(next) => set(item.key, next)} />
            ))}
          </tbody>
        </table>
        {preview.skipped.length > 0 ? (
          <details data-testid="import-skipped">
            <summary>건너뛴 파일 {preview.skipped.length}개</summary>
            <ul className="checks">
              {preview.skipped.map((s) => (
                <li key={s.path} className="check">
                  <span className="badge">건너뜀</span>
                  <div className="check-body">
                    <strong>{s.path}</strong>
                    <small className="hint">{s.reason}</small>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {props.message ? (
          <p role="alert" className="error" data-testid="import-message">
            {props.message}
          </p>
        ) : null}
      </div>
      <div className="ws-foot">
        <div className="row">
          <span className="hint grow">
            {props.local ? "고른 항목을 로컬 워크스페이스에 한 번에 저장합니다. 실행이나 플로우 만들기가 진행 중이면 끝난 뒤 가져옵니다." : "고른 항목을 새 가져오기 브랜치에 한 커밋으로 담습니다. 지금 작업 폴더와 브랜치는 바뀌지 않습니다."}
          </span>
          <button type="button" className="secondary" disabled={props.busy} onClick={props.onCancel}>
            취소
          </button>
          <button type="button" disabled={props.busy || count === 0} onClick={props.onApply}>
            {props.busy ? "가져오는 중" : `고른 항목 ${count}개 가져오기`}
          </button>
        </div>
      </div>
    </>
  );
}

function PreviewRow(props: { item: TransferItem; pick: PickState[string] | undefined; requiredBy: string[] | null; comparing: boolean; disabled: boolean; onCompare: () => void; onPick: (next: Partial<PickState[string]>) => void }) {
  const { item, pick } = props;
  const badge = STATUS_BADGE[item.status];
  const locked = props.requiredBy !== null && pick !== undefined;
  return (
    <>
      <tr data-testid={`import-row-${item.key}`}>
        <td className="transfer-pick">
          <input
            type="checkbox"
            aria-label={`${item.label} 가져오기`}
            checked={pick !== undefined && (pick.checked || locked)}
            disabled={pick === undefined || locked || props.disabled}
            title={locked ? `함께 들어갑니다(부르는 항목: ${props.requiredBy?.join(", ") ?? ""})` : undefined}
            onChange={(e) => props.onPick({ checked: e.target.checked })}
          />
        </td>
        <td>
          <strong>{item.label}</strong>
          <br />
          <span className="hint">{item.detail}</span>
        </td>
        <td>
          <span className={badge.className}>{badge.label}</span>
        </td>
        <td className="transfer-note-cell">
          <span>{item.note}</span>
          {locked ? <span className="hint"> 함께 들어갑니다(부르는 항목: {props.requiredBy?.join(", ")}).</span> : null}
          {item.compare.length > 0 ? (
            <>
              {" "}
              <button type="button" className="link" aria-expanded={props.comparing} onClick={props.onCompare}>
                {props.comparing ? "비교 닫기" : "비교 보기"}
              </button>
            </>
          ) : null}
          {pick && item.choices.length > 1 ? (
            <select aria-label={`${shortName(item)} 을 어떻게 할지`} value={pick.action} disabled={props.disabled} onChange={(e) => props.onPick({ action: e.target.value as TransferAction })}>
              {item.choices.map((c) => (
                <option key={c} value={c}>
                  {actionLabel(c, item)}
                </option>
              ))}
            </select>
          ) : null}
        </td>
      </tr>
      {props.comparing ? (
        <tr className="transfer-compare-row">
          <td colSpan={4}>
            {item.compare.map((c) => (
              <CompareView key={c.path} path={c.path} ours={c.ours} theirs={c.theirs} />
            ))}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CompareView(props: { path: string; ours: string; theirs: string }) {
  const diff = useMemo(() => lineDiff(props.ours, props.theirs), [props.ours, props.theirs]);
  return (
    <figure className="transfer-compare" aria-label={`${props.path} 비교`}>
      <figcaption>
        <code>{props.path}</code> <span className="hint">− 이 워크스페이스 · + 받은 것</span>
      </figcaption>
      {diff ? (
        <pre className="transfer-diff">
          {diff.map((line, i) => (
            <span key={i} className={`diff-${line.kind}`}>
              {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <div className="transfer-side">
          <pre className="transfer-diff">{props.ours}</pre>
          <pre className="transfer-diff">{props.theirs}</pre>
        </div>
      )}
    </figure>
  );
}

function Done(props: { state: Extract<ImportState, { step: "done" }>; onAgain: () => void }) {
  const { preview, picked, result } = props.state;
  const summary = importedSummary(preview.items, picked);
  const [review, setReview] = useState(() => defaultImportReview(preview.sourceLabel, summary));
  const [pr, setPr] = useState<RequestReviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function requestReview(event: FormEvent) {
    event.preventDefault();
    if (result.source !== "github") return;
    setBusy(true);
    setMessage(null);
    try {
      setPr(await window.qa.workspace.requestReview({ ...review, branch: result.branch }));
      notifyWorkspaceChanged();
    } catch (e) {
      setMessage(`PR 작성 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const renumbered =
    result.renumbered.length > 0 ? (
      <>
        <strong className="group-label">번호를 바꾼 것</strong>
        <ul className="checks" data-testid="import-renumbered">
          {result.renumbered.map((r) => (
            <li key={r.from} className="check">
              <span className="badge warn">번호 바꿈</span>
              <div className="check-body">
                <strong>
                  {r.from} → {r.to}
                </strong>
                <small className="hint">
                  {result.source === "github" ? "GitHub 워크스페이스" : "이 워크스페이스"}에 {r.from} 이 이미 있습니다
                </small>
              </div>
            </li>
          ))}
        </ul>
      </>
    ) : null;

  if (result.source === "local") {
    return (
      <>
        <div className="ws-body" data-testid="import-done">
          <div role="status" className="transfer-note">
            <strong>로컬 워크스페이스에 가져왔습니다</strong>
            <span>
              <code>{result.commit}</code> · {summary.text}. 테스트 케이스 화면과 실행 화면에서 바로 씁니다.
            </span>
          </div>
          {renumbered}
        </div>
        <div className="ws-foot">
          <div className="row">
            <span className="grow" />
            <button type="button" className="secondary" onClick={props.onAgain}>
              다른 것 가져오기
            </button>
          </div>
        </div>
      </>
    );
  }
  return (
    <form className="transfer-done" onSubmit={(e) => void requestReview(e)} aria-label="가져오기 결과">
      <div className="ws-body" data-testid="import-done">
        <div role="status" className="transfer-note">
          <strong>가져오기 브랜치에 커밋했습니다</strong>
          <span>
            <code>{result.branch}</code> <span className="hint">({result.commit})</span> · {summary.text}
          </span>
          <span>PR 을 머지하고 동기화할 때까지 가져온 항목은 고칠 수 없습니다. 머지 전에 고치면 브랜치가 갈라져 앱 설정이 없는 테스트 케이스가 생기기 때문입니다.</span>
        </div>
        <strong className="group-label">PR 작성</strong>
        <div className="stack">
          <label>
            제목
            <input value={review.title} onChange={(e) => setReview({ ...review, title: e.target.value })} required maxLength={200} disabled={pr !== null} />
          </label>
          <label>
            본문
            <textarea rows={5} value={review.body} onChange={(e) => setReview({ ...review, body: e.target.value })} disabled={pr !== null} />
          </label>
        </div>
        {renumbered}
        {pr ? (
          <p role="status" className="ok-text" data-testid="import-pr">
            {pr.existing ? `열린 PR #${pr.number} 에 올렸습니다: ` : `PR #${pr.number} 을 만들었습니다: `}
            <code>{pr.url}</code>
          </p>
        ) : null}
        {message ? (
          <p role="alert" className="error">
            {message}
          </p>
        ) : null}
      </div>
      <div className="ws-foot">
        <div className="row">
          <span className="hint grow">main 에는 직접 올리지 않습니다. 머지는 리뷰어가 합니다.</span>
          <button type="button" className="secondary" onClick={props.onAgain}>
            {pr ? "닫기" : "나중에"}
          </button>
          {pr ? null : (
            <button type="submit" disabled={busy || !review.title.trim()}>
              {busy ? "올리는 중" : "PR 작성"}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
