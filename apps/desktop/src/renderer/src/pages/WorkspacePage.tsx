import type { TestcaseList, WorkspaceStatus } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { AppSettingsEditor } from "../components/AppSettingsEditor";
import { errorMessage } from "../lib/errors";
import { notifyWorkspaceChanged, onWorkspaceChanged } from "../lib/workspace-events";

export function WorkspacePage() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [list, setList] = useState<TestcaseList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (next?: WorkspaceStatus) => {
    const s = next ?? (await window.qa.workspace.status());
    setStatus(s);
    setList(s.connected ? await window.qa.workspace.testcases() : null);
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => setMessage(errorMessage(e)));
    // 툴바에서 동기화하면 다시 읽는다
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

  return (
    <>
      <h1>워크스페이스</h1>
      <section className="card stack" aria-label="워크스페이스 상태">
        <p className="hint">TC·플로우를 팀이 공유하는 GitHub 저장소입니다. 저장하면 작업 브랜치에 커밋하고, PR 작성을 누르면 PR 을 만듭니다. main 에 직접 올리지 않습니다.</p>
        {status ? (
          <dl data-testid="workspace-status">
            <dt>저장소</dt>
            <dd>{status.repo ?? "설정에서 GitHub 조직을 정합니다"}</dd>
            {status.connected ? (
              <>
                <dt>브랜치</dt>
                <dd>
                  {status.branch} ({status.head}){status.ahead ? ` · main 보다 ${status.ahead}개 앞섬` : ""}
                  {status.behind ? ` · ${status.behind}개 뒤처짐` : ""}
                </dd>
                <dt>바뀐 파일</dt>
                <dd>{status.dirty.length ? status.dirty.join(", ") : "없음"}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p>불러오는 중</p>
        )}
        <div className="row">
          {!status?.connected ? (
            <button type="button" disabled={busy !== null || !status?.repo} onClick={() => void act("연결", () => window.qa.workspace.connect())}>
              {busy === "연결" ? "연결 중" : "연결(clone)"}
            </button>
          ) : (
            <small className="hint">원격의 새 커밋은 위 툴바의 동기화로 받습니다. main 을 보고 있을 때 main 을 최신으로 맞춥니다.</small>
          )}
        </div>
        {message ? (
          <p role="status" data-testid="workspace-message">
            {message}
          </p>
        ) : null}
      </section>

      {status?.connected && list ? <AppSettingsEditor apps={list.apps} /> : null}

      {list && list.issues.length > 0 ? (
        <section className="card stack" aria-label="워크스페이스 문제">
          <h2>문제 {list.issues.length}개</h2>
          <ul className="checks">
            {list.issues.map((i) => (
              <li key={`${i.path}:${i.message}`} className="warning">
                <code>
                  {i.path}
                  {i.line ? `:${i.line}` : ""}
                </code>{" "}
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {status?.connected ? <p className="hint">TC 목록·편집·PR 작성은 메뉴 "TC"에서 합니다.</p> : null}
    </>
  );
}
