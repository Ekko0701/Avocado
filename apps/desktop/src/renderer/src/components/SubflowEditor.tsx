import type { RequestReviewResult, SubflowList } from "@qa/shared";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";
import { notifyWorkspaceChanged } from "../lib/workspace-events";

const MAESTRO_COMMANDS_DOC = "https://docs.maestro.dev/reference/commands-available";
const MAESTRO_SELECTORS_DOC = "https://docs.maestro.dev/maestro-flows/flow-control-and-logic/how-to-use-selectors";

/** 서브플로우에서 자주 쓰는 Maestro 명령(앱이 쓰는 Maestro 2.11.0 기준). 전체 목록은 공식 문서에 있다 */
const COMMON_COMMANDS: { names: string[]; use: string; example: string }[] = [
  {
    names: ["launchApp"],
    use: "앱을 띄운다. clearState 는 앱 데이터, clearKeychain 은 iOS 키체인을 지운다. stopApp: false 면 다시 시작하지 않고 앞으로 가져온다. permissions 로 권한을 허용·거부하고 arguments 로 실행 인자를 넘긴다",
    example: "- launchApp: {clearState: true}",
  },
  { names: ["clearKeychain", "clearState"], use: "앱을 띄우지 않고 iOS 키체인(시뮬레이터 전체) 또는 앱 데이터만 지운다", example: "- clearKeychain" },
  { names: ["stopApp", "killApp"], use: "앱을 멈춘다. killApp 은 강제로 끝낸다", example: "- stopApp" },
  {
    names: ["extendedWaitUntil"],
    use: "요소가 보일(visible) 때까지 또는 사라질(notVisible) 때까지 timeout(밀리초)만큼 기다린다. visible 과 notVisible 중 하나는 꼭 있어야 한다",
    example: '- extendedWaitUntil: {visible: "로그인", timeout: 15000}',
  },
  { names: ["assertVisible", "assertNotVisible"], use: "요소가 보이는지, 보이지 않는지 확인한다. 몇 초 동안 다시 확인한다", example: '- assertVisible: "홈"' },
  { names: ["waitForAnimationToEnd"], use: "화면 애니메이션이 끝날 때까지 기다린다", example: "- waitForAnimationToEnd: {timeout: 3000}" },
  {
    names: ["tapOn", "longPressOn", "doubleTapOn"],
    use: "글자(text, 정규식)·id·index 로 고른 요소를 누른다. optional, retryTapIfNoChange, repeat, delay 를 붙일 수 있다",
    example: '- tapOn: {text: "지금 안 함", optional: true}',
  },
  {
    names: ["scrollUntilVisible", "swipe", "scroll"],
    use: "요소가 보일 때까지 스크롤한다(direction: DOWN 등). swipe 는 방향으로 쓸고, scroll 은 아래로 한 번 스크롤한다",
    example: '- scrollUntilVisible: {element: {text: "로그아웃"}, direction: DOWN}',
  },
  {
    names: ["inputText", "eraseText", "hideKeyboard", "pressKey"],
    use: "글자를 입력하고, 지우고, 키보드를 닫고, 키(Enter 등)를 누른다. ${KEY} 는 앱 계정 역할의 키만 쓸 수 있다",
    example: "- inputText: ${TEST_PASSWORD}",
  },
  { names: ["inputRandomEmail", "inputRandomText", "inputRandomNumber", "inputRandomPersonName"], use: "무작위 값을 입력한다(실행마다 새 계정을 만들 때)", example: "- inputRandomEmail" },
  {
    names: ["runFlow"],
    use: "같은 common 폴더의 다른 서브플로우를 부른다. when 에 visible·notVisible·platform 을 주면 조건이 맞을 때만 부른다",
    example: '- runFlow: {file: close-keyboard.yaml, when: {visible: "완료"}}',
  },
  {
    names: ["repeat", "retry"],
    use: "명령 묶음을 반복한다(times, while). retry 는 실패하면 maxRetries 만큼 다시 한다",
    example: '- retry: {maxRetries: 2, commands: [{tapOn: "다시 시도"}]}',
  },
];

/**
 * 공통 서브플로우(그 앱 플로우 폴더의 <타깃>/common/*.yaml) 편집. 있는 파일만 고친다.
 * 저장하면 main 이 서브플로우 규약을 검사하고 그 앱의 앱 설정 작업 브랜치에 커밋한다. PR 작성은 앱 설정과 같다.
 * 어느 앱인지는 워크스페이스 화면의 왼쪽 목록이 정한다. 파일 목록 · 편집기 · 자주 쓰는 Maestro 명령을 나란히 둔다
 */
export function SubflowEditor(props: { app: string; title: string; tabs?: ReactNode; hidden?: boolean; onCount?: (count: number | null) => void }) {
  const { app, onCount } = props;
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
    return next.subflows.length;
  }, []);

  useEffect(() => {
    setList(null);
    setPr(null);
    setSaved(null);
    setMessage(null);
    // 앱이 바뀌면 탭의 파일 수를 비웠다가 읽은 뒤 다시 알린다
    onCount?.(null);
    if (!app) return;
    let stale = false;
    load(app, null).then(
      (count) => {
        if (!stale) onCount?.(count);
      },
      (e: unknown) => setMessage(`서브플로우를 읽지 못했습니다: ${errorMessage(e)}`),
    );
    return () => {
      stale = true;
    };
    // onCount 는 부모가 매번 새로 만드는 함수라 의존하지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <form className="card ws-detail" aria-label="공통 서브플로우" data-testid="subflows" hidden={props.hidden} onSubmit={(e) => void save(e)}>
      <div className="ws-head">
        <div className="ws-head-title">
          <h2>{props.title}</h2>
          {props.tabs}
        </div>
        <small className="hint">
          플로우가 runFlow 로 부르는 공통 단계입니다(앱의 플로우 폴더 아래 &lt;타깃&gt;/common/). 고치면 이 서브플로우를 부르는 모든 플로우에 적용됩니다. 실행이나 플로우 만들기가 진행 중일 때는 저장하지
          않습니다.
        </small>
      </div>
      <div className="ws-body ws-subflow">
        <div className="ws-files" aria-label="서브플로우 파일">
          <strong className="group-label">파일</strong>
          {list === null ? <p className="hint">불러오는 중</p> : null}
          {list && list.subflows.length === 0 ? <p className="hint">이 앱에는 공통 서브플로우가 없습니다.</p> : null}
          {list?.subflows.map((s) => (
            <button
              key={s.path}
              type="button"
              className={s.path === path ? "run-item selected" : "run-item"}
              aria-current={s.path === path ? "true" : undefined}
              data-testid={`subflow-file-${s.target}-${s.name}`}
              title={`${s.target}/common/${s.name}`}
              onClick={() => pick(s.path)}
            >
              <span className="run-item-body">
                <strong>{s.name}</strong>
                <small className="hint">{s.target}/common</small>
              </span>
            </button>
          ))}
        </div>

        <div className="ws-editor">
          {current ? (
            <>
              <strong className="group-label">
                {current.target}/common/{current.name}
              </strong>
              <textarea className="editor" aria-label="서브플로우 내용" value={text} onChange={(e) => setText(e.target.value)} rows={16} spellCheck={false} />
              <small className="hint" data-testid="subflow-used-by">
                {current.usedBy.length > 0 ? `이 서브플로우를 부르는 플로우: ${current.usedBy.join(", ")}` : "이 서브플로우를 부르는 플로우가 없습니다."}
              </small>
              <small className="hint">저장할 때 규약과 Maestro 문법(check-syntax)을 검사합니다.</small>
            </>
          ) : null}
          {list?.branch ? <small className="hint">진행 중인 앱 설정 브랜치 {list.branch} 에서 읽었습니다.</small> : null}
        </div>

        <aside className="ws-ref" aria-label="자주 쓰는 Maestro 명령" data-testid="maestro-help">
          <strong className="group-label">자주 쓰는 Maestro 명령</strong>
          <dl className="maestro-ref">
            {COMMON_COMMANDS.map((c) => (
              <div key={c.names[0]} className="maestro-ref-row">
                <dt>
                  {c.names.map((n) => (
                    <code key={n}>{n}</code>
                  ))}
                </dt>
                <dd>
                  <span>{c.use}</span>
                  <code>{c.example}</code>
                </dd>
              </div>
            ))}
          </dl>
          <p className="hint">
            모든 명령에 <code>optional: true</code>(실패해도 다음으로 간다)와 <code>label</code>(결과에 보일 이름)을 붙일 수 있습니다. Avocado 는 <code>runScript</code>·
            <code>evalScript</code>(코드 실행), 좌표 탭(<code>point</code>), 웹 주소 <code>openLink</code>(딥링크만 됨), 계정 역할에 없는 <code>{"${KEY}"}</code> 를 막습니다. AI 명령(
            <code>assertWithAI</code> 등)은 Maestro 클라우드가 필요하고 화면이 밖으로 나가므로 쓰지 않습니다.
          </p>
          <p className="hint">앱은 Maestro 2.11.0 을 씁니다. 문서에 있어도 이 버전에 없는 명령과 옵션은 동작하지 않습니다.</p>
          <div className="ws-ref-links">
            <button type="button" className="link" onClick={() => void window.qa.app.openExternal({ url: MAESTRO_COMMANDS_DOC }).catch((e: unknown) => setMessage(errorMessage(e)))}>
              모든 명령과 옵션 (Maestro 공식 문서)
            </button>
            <button type="button" className="link" onClick={() => void window.qa.app.openExternal({ url: MAESTRO_SELECTORS_DOC }).catch((e: unknown) => setMessage(errorMessage(e)))}>
              요소 고르는 법 (선택자)
            </button>
          </div>
        </aside>
      </div>

      <div className="ws-foot">
        {current ? (
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
      </div>
    </form>
  );
}
