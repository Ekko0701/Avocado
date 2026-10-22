import type { AgentProvider, ClaudeConnection } from "@qa/shared";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";

const DESKTOP_STATE: Record<ClaudeConnection["desktop"]["state"], string> = {
  missing_app: "Claude 데스크톱 앱이 없습니다(설치하고 한 번 연 뒤 등록합니다)",
  not_configured: "아직 등록하지 않았습니다",
  configured: "등록했습니다",
  outdated: "다른 설정으로 등록돼 있습니다(다시 등록하면 고칩니다)",
  invalid: "설정 파일이 JSON 이 아니라 건드리지 않습니다(파일을 고친 뒤 등록합니다)",
};

/**
 * 플로우 만들기·화면 판정을 누구의 Claude 로 하나(D17, ADR 0022). 기본은 각자의 Claude 앱에 MCP 로 연결해 그 요금제·한도를 쓴다.
 * 앱은 Claude 로그인을 다루지 않는다(Anthropic 정책). 연결은 각자의 Claude 앱 설정에 Avocado 를 등록하는 것이다.
 * 설정 화면과 설정 마법사가 함께 쓴다. API 키 방식을 고르면 apiKeySlot(키 입력이나 안내)을 보인다.
 */
export function ClaudeConnectionPanel(props: { provider: AgentProvider; onSaved: () => Promise<void> | void; apiKeySlot?: ReactNode }) {
  const [provider, setProvider] = useState<AgentProvider>(props.provider);
  const [status, setStatus] = useState<ClaudeConnection | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    window.qa.claude.status().then(setStatus, (e: unknown) => setMessage(`연결 상태를 읽지 못했습니다: ${errorMessage(e)}`));
  }, []);
  useEffect(load, [load]);

  async function saveProvider(next: AgentProvider) {
    setProvider(next);
    try {
      await window.qa.settings.update({ agent: { provider: next } });
      setMessage("저장했습니다");
      await props.onSaved();
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  async function connectDesktop() {
    try {
      setStatus(await window.qa.claude.connectDesktop());
      setMessage("Claude 데스크톱 앱에 등록했습니다. Claude 데스크톱 앱을 다시 시작하면 avocado 도구가 보입니다.");
    } catch (e) {
      setMessage(`등록하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(
      () => setMessage("명령을 복사했습니다. 터미널에 붙여 넣어 실행합니다."),
      (e: unknown) => setMessage(`복사하지 못했습니다(글자를 직접 선택해 복사합니다): ${errorMessage(e)}`),
    );
  }

  return (
    <div className="stack" data-testid="claude-connection">
      <fieldset className="row">
        <legend className="hint">플로우 만들기에 쓰는 Claude</legend>
        <label>
          <input type="radio" name="agent-provider" checked={provider === "claude-app"} onChange={() => void saveProvider("claude-app")} />
          내 Claude 앱(데스크톱·Code) · 각자의 요금제 한도
        </label>
        <label>
          <input type="radio" name="agent-provider" checked={provider === "api"} onChange={() => void saveProvider("api")} />
          Anthropic API 키 · 앱이 직접 호출, 월 비용 상한
        </label>
      </fieldset>
      {provider === "claude-app" ? (
        <>
          {status ? (
            <p className={status.listening ? "hint" : "warning"} role={status.listening ? undefined : "alert"} data-testid="claude-listening">
              {status.listening
                ? `Claude 연결을 기다리는 중입니다. 연결된 Claude: ${status.clients.length ? status.clients.map((c) => `${c.name} ${c.version}`).join(", ") : "없음"}`
                : `Claude 연결을 열지 못했습니다: ${status.error ?? "알 수 없는 이유"}`}
            </p>
          ) : null}
          <div className="row">
            <span>
              Claude 데스크톱 앱: <span data-testid="claude-desktop-state">{status ? DESKTOP_STATE[status.desktop.state] : "확인 중"}</span>
            </span>
            <button
              type="button"
              onClick={() => void connectDesktop()}
              disabled={!status || status.desktop.state === "configured" || status.desktop.state === "missing_app" || status.desktop.state === "invalid"}
            >
              Claude 데스크톱 앱에 등록
            </button>
          </div>
          {status ? (
            <div className="stack">
              <span>Claude Code (터미널·데스크톱 앱의 Code): 아래 명령을 터미널에서 한 번 실행합니다.</span>
              <div className="row">
                <code className="grow" data-testid="claude-code-command">
                  {status.codeCommand}
                </code>
                <button type="button" className="secondary" onClick={() => copy(status.codeCommand)}>
                  복사
                </button>
              </div>
            </div>
          ) : null}
          <p className="hint">
            Avocado 를 먼저 켠 뒤 Claude 를 엽니다(Claude 가 먼저 켜져 있었다면 데스크톱 앱은 다시 시작, Claude Code 는 /mcp 에서 다시 연결). Avocado 작업 중에는 Claude Code 의 권한
            확인을 끄는 모드를 쓰지 않습니다. 화면 캡처와 화면 글자가 각자의 Claude 계정으로 갑니다. 화면에 민감한 정보가 있는 앱은 요금제와 "모델 개선에 참여" 설정을 먼저 확인합니다.
          </p>
        </>
      ) : null}
      {provider === "api" ? props.apiKeySlot : null}
      {message ? (
        <small role="status" className="hint">
          {message}
        </small>
      ) : null}
    </div>
  );
}
