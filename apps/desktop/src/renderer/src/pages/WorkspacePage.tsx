import type { TestcaseList, WorkspaceStatus } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { AppSettingsEditor, NEW_APP } from "../components/AppSettingsEditor";
import { Icon } from "../components/Icon";
import { LayoutMigration, needsLayoutMigration } from "../components/LayoutMigration";
import { SubflowEditor } from "../components/SubflowEditor";
import { errorMessage } from "../lib/errors";
import { TARGET_LABEL } from "../lib/results";
import { notifyWorkspaceChanged, onWorkspaceChanged } from "../lib/workspace-events";

const PROBLEMS = "__problems__";
const LAYOUT = "__layout__";
const targetLabel = (t: string) => (t in TARGET_LABEL ? TARGET_LABEL[t as keyof typeof TARGET_LABEL] : t);

/**
 * 워크스페이스: 위는 저장소 상태 한 줄(브랜치·바뀐 파일의 자세한 내용은 Git 상태 인스펙터), 왼쪽은 앱 목록과 문제,
 * 오른쪽은 고른 앱의 탭(앱 설정 | 공통 서브플로우). 테스트 케이스는 메뉴 "테스트 케이스"에서 다룬다
 */
export function WorkspacePage(props: { onOpenInspector?: () => void; onOpenSettings?: () => void }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [list, setList] = useState<TestcaseList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** 왼쪽에서 고른 것: 앱 id, 새 앱, 문제, 폴더 구조. 고르기 전(null)에는 기본을 쓴다 */
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"settings" | "subflows">("settings");
  const [subflowCount, setSubflowCount] = useState<number | null>(null);

  const refresh = useCallback(async (next?: WorkspaceStatus) => {
    const s = next ?? (await window.qa.workspace.status());
    setStatus(s);
    setList(s.connected ? await window.qa.workspace.testcases() : null);
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => setMessage(errorMessage(e)));
    // 툴바에서 동기화하거나 저장하면 다시 읽는다
    return onWorkspaceChanged(() => void refresh().catch((e: unknown) => setMessage(errorMessage(e))));
  }, [refresh]);

  async function act(label: string, fn: () => Promise<WorkspaceStatus>) {
    setBusy(label);
    setMessage(null);
    try {
      await refresh(await fn());
      notifyWorkspaceChanged();
    } catch (e) {
      setMessage(`${label} 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const connected = status?.connected === true;
  const apps = list?.apps ?? [];
  const issues = list?.issues ?? [];
  const layout = status !== null && needsLayoutMigration(status);
  // 폴더 구조를 바꿔야 하면 그것부터, 아니면 첫 앱(없으면 새 앱)을 연다
  const selected = picked ?? (layout ? LAYOUT : (apps[0]?.app ?? NEW_APP));
  const isApp = selected !== PROBLEMS && selected !== LAYOUT;
  const creating = selected === NEW_APP;
  // 방금 만든 앱은 main 에 들어가기 전이라 목록에 없을 수 있다
  const pending = isApp && !creating && !apps.some((a) => a.app === selected) ? selected : null;
  const appName = apps.find((a) => a.app === selected)?.name ?? selected;

  function pick(next: string) {
    // 이미 고른 것을 다시 누르면 보던 탭을 그대로 둔다
    if (next === selected) return;
    setPicked(next);
    setTab("settings");
  }

  const tabs =
    isApp && !creating ? (
      <div role="tablist" aria-label="앱에서 고칠 것">
        <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>
          앱 설정
        </button>
        <button type="button" role="tab" aria-selected={tab === "subflows"} onClick={() => setTab("subflows")}>
          공통 서브플로우{subflowCount === null ? "" : ` ${subflowCount}`}
        </button>
      </div>
    ) : null;

  return (
    <div className="ws-page">
      <h1>워크스페이스</h1>
      <section className="card ws-status" aria-label="워크스페이스 상태">
        {status ? (
          <>
            <span className={connected ? "dot on" : "dot waiting"} aria-hidden="true" />
            <div className="ws-status-text" data-testid="workspace-status">
              <strong>{status.repo ?? "설정에서 GitHub 조직을 정합니다"}</strong>
              {connected ? (
                <>
                  <span className="ws-branch">
                    <Icon name="branch" size={13} />
                    <strong>{status.branch}</strong>
                  </span>
                  <span className="hint" title={status.dirty.length ? status.dirty.join("\n") : undefined}>
                    {status.head}
                    {status.ahead ? ` · main 보다 ${status.ahead}개 앞섬` : ""}
                    {status.behind ? ` · ${status.behind}개 뒤처짐` : ""} · 바뀐 파일 {status.dirty.length ? `${status.dirty.length}개` : "없음"}
                  </span>
                </>
              ) : (
                <span className="hint">{status.repo ? "아직 이 Mac 에 받지 않았습니다. 연결하면 저장소를 받아(clone) 앱 설정과 테스트 케이스를 읽고 고칠 수 있습니다." : "저장소와 토큰은 설정 → GitHub 에서 정합니다."}</span>
              )}
            </div>
            {connected ? (
              <>
                <small className="hint ws-status-note">저장하면 작업 브랜치에 커밋합니다. main 에는 PR 로만 들어갑니다.</small>
                {props.onOpenInspector ? (
                  <button type="button" className="secondary small" onClick={props.onOpenInspector}>
                    Git 상태 열기
                  </button>
                ) : null}
              </>
            ) : (
              <>
                {!status.repo && props.onOpenSettings ? (
                  <button type="button" className="secondary" onClick={props.onOpenSettings}>
                    설정 열기
                  </button>
                ) : null}
                <button type="button" disabled={busy !== null || !status.repo} onClick={() => void act("연결", () => window.qa.workspace.connect())}>
                  {busy === "연결" ? "연결 중" : "연결(clone)"}
                </button>
              </>
            )}
          </>
        ) : (
          <p>불러오는 중</p>
        )}
      </section>
      {message ? (
        <p role="status" data-testid="workspace-message">
          {message}
        </p>
      ) : null}

      <div className="ws-panes">
        <nav className="card ws-nav" aria-label="앱과 문제">
          <strong className="group-label">앱</strong>
          {!connected ? <p className="hint">연결하면 보입니다.</p> : null}
          {apps.map((a) => {
            const count = list?.testcases.filter((t) => t.app === a.app).length ?? 0;
            return (
              <button key={a.app} type="button" className={a.app === selected ? "run-item selected" : "run-item"} aria-current={a.app === selected ? "page" : undefined} data-testid={`ws-nav-${a.app}`} onClick={() => pick(a.app)}>
                <span className="run-item-body">
                  <strong>
                    {a.name} <span className="ws-app-id">({a.app})</span>
                  </strong>
                  <small className="hint">
                    {a.targets.length ? a.targets.map(targetLabel).join("·") : "타깃 없음"} · 테스트 케이스 {count}개
                  </small>
                </span>
              </button>
            );
          })}
          {pending ? (
            <button type="button" className="run-item selected" aria-current="page" data-testid={`ws-nav-${pending}`}>
              <span className="run-item-body">
                <strong>{pending}</strong>
                <small className="hint">아직 main 에 없는 앱</small>
              </span>
            </button>
          ) : null}
          {connected ? (
            <button type="button" className={creating ? "run-item selected" : "run-item"} aria-current={creating ? "page" : undefined} data-testid="ws-nav-new" onClick={() => pick(NEW_APP)}>
              <span className="run-item-body">
                <strong>＋ 새 앱</strong>
              </span>
            </button>
          ) : null}
          <span className="ws-nav-gap" />
          {layout ? (
            <button type="button" className={selected === LAYOUT ? "run-item selected" : "run-item"} aria-current={selected === LAYOUT ? "page" : undefined} data-testid="ws-nav-layout" onClick={() => pick(LAYOUT)}>
              <span className="run-item-body">
                <strong>폴더 구조</strong>
                <small className="hint">앱별 폴더로 바꾸기</small>
              </span>
              <span className="dot waiting" aria-hidden="true" />
            </button>
          ) : null}
          {connected ? (
            <button type="button" className={selected === PROBLEMS ? "run-item selected" : "run-item"} aria-current={selected === PROBLEMS ? "page" : undefined} data-testid="ws-nav-problems" onClick={() => pick(PROBLEMS)}>
              <span className="run-item-body">
                <strong>문제</strong>
                <small className="hint">형식이 맞지 않는 파일</small>
              </span>
              {issues.length > 0 ? <span className="badge bad">{issues.length}</span> : <small className="hint">없음</small>}
            </button>
          ) : null}
        </nav>

        {!connected ? (
          <section className="card ws-empty" aria-label="앱 설정">
            <strong>워크스페이스를 연결하면 앱이 여기에 보입니다</strong>
            <p className="hint">테스트 케이스·플로우를 팀이 공유하는 GitHub 저장소입니다. 저장소와 토큰은 설정 → GitHub 에서 정합니다.</p>
          </section>
        ) : null}

        {/* 탭을 오가도 고치던 내용이 남게 두 편집기를 함께 두고 안 보는 쪽만 숨긴다 */}
        {connected && list && isApp ? <AppSettingsEditor apps={apps} selected={selected} onSelect={pick} tabs={tabs} hidden={tab !== "settings"} /> : null}
        {connected && list && isApp && !creating ? <SubflowEditor app={selected} title={`${appName} (${selected})`} tabs={tabs} hidden={tab !== "subflows"} onCount={setSubflowCount} /> : null}

        {connected && status && selected === LAYOUT ? <LayoutMigration status={status} onChanged={(next) => void refresh(next).catch((e: unknown) => setMessage(errorMessage(e)))} /> : null}

        {connected && selected === PROBLEMS ? (
          <section className="card ws-detail" aria-label="워크스페이스 문제">
            <div className="ws-head">
              <h2>{issues.length > 0 ? `문제 ${issues.length}개` : "문제"}</h2>
              <small className="hint">형식이 맞지 않아 목록·실행에서 빠진 파일입니다. 고쳐서 저장하면 여기서 사라집니다.</small>
            </div>
            <div className="ws-body">
              {issues.length === 0 ? <p className="hint">문제가 없습니다.</p> : null}
              <ul className="checks">
                {issues.map((i) => (
                  <li key={`${i.path}:${i.message}`} className="check">
                    <span className="badge bad">형식</span>
                    <div className="check-body">
                      <code>
                        {i.path}
                        {i.line ? `:${i.line}` : ""}
                      </code>
                      <span>{i.message}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
