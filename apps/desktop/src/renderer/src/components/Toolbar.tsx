import type { ClaudeConnection, WorkspaceStatus } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";
import { inProgressCount } from "../lib/git-state";
import { notifyWorkspaceChanged, onWorkspaceChanged } from "../lib/workspace-events";
import { Icon } from "./Icon";

/**
 * 본문 위에 뜬 툴바(Liquid Glass). 바 자체는 투명하고 항목은 유리 캡슐이다. 왼쪽 동기화, 가운데 워크스페이스·브랜치, 오른쪽 Claude 연결 상태와 Git 상태 인스펙터 버튼.
 * 본문은 툴바 밑으로 스크롤된다. 툴바 전체가 창 끌기 영역이고 버튼만 누를 수 있다. 상태는 8초마다, 창에 돌아올 때, 다른 화면이 바꿨다고 알릴 때 다시 읽는다.
 */
export function Toolbar(props: { page: string | null; onNavigate: (page: "workspace" | "settings") => void; inspectorOpen: boolean; onToggleInspector: () => void }) {
  const [ws, setWs] = useState<WorkspaceStatus | null>(null);
  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [provider, setProvider] = useState<"api" | "claude-app" | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Git 상태 버튼의 배지: main 에 아직 없는 변경이 있는 작업 브랜치 수 */
  const [inProgress, setInProgress] = useState(0);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(() => {
    window.qa.workspace.status().then(setWs, () => setWs(null));
    window.qa.claude.status().then(setClaude, () => setClaude(null));
    window.qa.settings.get().then((s) => setProvider(s.settings.agent.provider), () => undefined);
  }, []);

  // 작업 브랜치 수는 git 을 여러 번 불러 8초마다 읽지 않는다. 화면을 옮길 때, 창에 돌아올 때, 다른 화면이 바꿨다고 알릴 때만 읽는다
  const refreshInProgress = useCallback(() => {
    window.qa.workspace
      .status()
      .then((s) => (s.connected ? window.qa.workspace.branches().then((b) => inProgressCount(b.branches)) : 0))
      .then(setInProgress, () => setInProgress(0));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 8000);
    const changed = () => {
      refresh();
      refreshInProgress();
    };
    const off = onWorkspaceChanged(changed);
    window.addEventListener("focus", changed);
    return () => {
      clearInterval(timer);
      off();
      window.removeEventListener("focus", changed);
    };
  }, [refresh, refreshInProgress]);

  // 다른 화면으로 옮기면 바로 다시 읽는다(그 화면에서 연결·브랜치를 바꿨을 수 있다)
  useEffect(() => {
    refresh();
    refreshInProgress();
  }, [props.page, refresh, refreshInProgress]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  async function sync() {
    setSyncing(true);
    setMessage(null);
    try {
      const s = await window.qa.workspace.sync();
      setWs(s);
      setMessage({
        text: s.behind === 0 ? "원격과 같습니다" : s.onMain ? `원격 커밋 ${s.behind}개를 아직 받지 못했습니다` : `원격 main 에 새 커밋 ${s.behind}개 · main 에서 동기화하면 받습니다`,
        error: false,
      });
      notifyWorkspaceChanged();
    } catch (e) {
      setMessage({ text: `동기화 실패: ${errorMessage(e)}`, error: true });
    } finally {
      setSyncing(false);
    }
  }

  const repoName = ws?.repo ?? "워크스페이스 없음";
  const claudeState = provider === "api" ? "api" : !claude ? "unknown" : !claude.listening ? "off" : claude.clients.length > 0 ? "on" : "waiting";
  const claudeText =
    claudeState === "api" ? "API 키 방식" : claudeState === "on" ? `Claude ${claude?.clients.length ?? 0}` : claudeState === "waiting" ? "Claude 대기" : claudeState === "off" ? "Claude 꺼짐" : "Claude";

  return (
    <header className="toolbar" aria-label="툴바">
      <div className="toolbar-actions glass capsule">
        <button type="button" className="tool" aria-label="워크스페이스 동기화" disabled={!ws?.connected || syncing} onClick={() => void sync()}>
          <Icon name="sync" size={16} className={syncing ? "spin" : undefined} />
          <span>{syncing ? "받는 중" : "동기화"}</span>
        </button>
      </div>
      <button
        type="button"
        className="context glass capsule"
        data-testid="toolbar-workspace"
        aria-label={`현재 워크스페이스 ${repoName}${ws?.branch ? ` 브랜치 ${ws.branch}` : ""}`}
        onClick={() => props.onNavigate("workspace")}
      >
        <Icon name="folder" size={16} />
        <span className="context-text">
          <strong>{repoName}</strong>
          {ws?.connected ? (
            <small>
              <Icon name="branch" size={12} />
              <span className="context-branch">{ws.branch}</span>
              {ws.ahead > 0 ? <span title="원격 main 보다 앞선 커밋">↑{ws.ahead}</span> : null}
              {ws.behind > 0 ? <span title="원격 main 에서 받지 않은 커밋">↓{ws.behind}</span> : null}
              {ws.dirty.length > 0 ? <span title="저장하지 않은 파일">● {ws.dirty.length}</span> : null}
            </small>
          ) : (
            <small>{ws?.repo ? "아직 연결하지 않았습니다" : "설정에서 저장소를 고릅니다"}</small>
          )}
        </span>
      </button>
      <div className="toolbar-trail">
        {message ? (
          <span role="status" className={message.error ? "toolbar-message glass capsule error" : "toolbar-message glass capsule"} data-testid="toolbar-message">
            {message.text}
          </span>
        ) : null}
        <button type="button" className="tool status glass capsule" aria-label={`Claude 연결 상태: ${claudeText}`} onClick={() => props.onNavigate("settings")}>
          <span className={`dot ${claudeState}`} aria-hidden="true" />
          <span>{claudeText}</span>
        </button>
        <button
          type="button"
          className={props.inspectorOpen ? "tool status glass capsule git-toggle on" : "tool status glass capsule git-toggle"}
          data-testid="toolbar-git"
          aria-pressed={props.inspectorOpen}
          aria-label={props.inspectorOpen ? "Git 상태 닫기" : inProgress > 0 ? `Git 상태 열기, 진행 중 ${inProgress}개` : "Git 상태 열기"}
          onClick={props.onToggleInspector}
        >
          <Icon name="branch" size={16} />
          <span>Git 상태</span>
          {inProgress > 0 ? (
            <span className="tool-count" data-testid="toolbar-git-count" aria-hidden="true">
              {inProgress}
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
