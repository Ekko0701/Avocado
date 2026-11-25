import type { CliInfo } from "@qa/shared";
import { useState } from "react";
import { errorMessage } from "../lib/errors";

const EXAMPLES: { command: string; note: string }[] = [
  { command: "avocado qa options", note: "테스트 케이스, 준비된 기기, 빌드를 봅니다" },
  { command: "avocado qa run demo-TC-0101 --device <기기 id>", note: "실행하고 끝까지 따라갑니다. Ctrl-C 는 이 실행만 취소합니다" },
  { command: "avocado qa run --app demo --tag smoke --json", note: "태그로 차례 실행, 결과는 JSON 으로" },
];

/**
 * 설정의 "터미널" 구역(T-122, ADR 0035 결정 6·D19): 앱 번들의 avocado 명령을 PATH 에 거는 명령과 건 상태.
 * 앱은 앱 데이터 밖에 쓰지 않는다. 사람이 명령을 복사해 터미널에서 실행한다
 */
export function TerminalSection(props: { info: CliInfo | null; error: string | null; onRefresh: () => void }) {
  const { info } = props;
  const [message, setMessage] = useState<string | null>(null);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => setMessage("명령을 복사했습니다. 터미널에 붙여 넣어 실행한 뒤 다시 확인을 누릅니다."),
      (e: unknown) => setMessage(`복사하지 못했습니다(글자를 직접 선택해 복사합니다): ${errorMessage(e)}`),
    );
  const linked = info?.link === "this";
  return (
    <section className="card settings-detail" aria-labelledby="terminal-title" data-testid="terminal-section">
      <div className="settings-head">
        <h2 id="terminal-title">터미널</h2>
        <small className="hint">터미널에서 avocado 명령으로 테스트 케이스를 실행합니다. CI 나 스크립트에서도 씁니다.</small>
      </div>
      <div className="settings-body">
        {props.error ? (
          <p role="alert" className="error">
            명령 상태를 읽지 못했습니다: {props.error}
          </p>
        ) : null}
        <strong className="group-label">명령 연결</strong>
        {info && !info.available ? (
          <p className="hint" data-testid="terminal-dev">
            개발 실행에는 번들 명령이 없습니다. 저장소에서 <code>pnpm avocado qa options</code> 처럼 씁니다.
          </p>
        ) : null}
        {info?.available && info.linkCommand ? (
          <ul className="checks">
            <li className="check">
              <span className={linked ? "badge ok" : "badge"} data-testid="terminal-link-state">
                {linked ? "연결됨" : info.link === "other" ? "다른 파일" : "연결 전"}
              </span>
              <div className="check-body">
                <strong>{info.linkPath}</strong>
                <small className="hint">
                  {linked
                    ? "이 앱의 명령을 가리킵니다. 앱을 같은 자리에 다시 설치하면 그대로 씁니다."
                    : info.link === "other"
                      ? "다른 파일이나 다른 자리의 앱을 가리킵니다. 아래 명령으로 이 앱을 가리키게 바꿉니다."
                      : "아래 명령을 터미널에서 한 번 실행합니다. Avocado 는 앱 데이터 밖에 파일을 만들지 않습니다."}
                </small>
                <code className="claude-command" data-testid="terminal-link-command">
                  {info.linkCommand}
                </code>
              </div>
              <div className="row">
                <button type="button" className="secondary small" onClick={() => copy(info.linkCommand ?? "")}>
                  복사
                </button>
                <button type="button" className="secondary small" onClick={props.onRefresh}>
                  다시 확인
                </button>
              </div>
            </li>
          </ul>
        ) : null}
        <hr className="rule" />
        <strong className="group-label">써 보기</strong>
        <ul className="checks">
          {EXAMPLES.map((e) => (
            <li key={e.command} className="check">
              <div className="check-body">
                <code className="claude-command">{e.command}</code>
                <small className="hint">{e.note}</small>
              </div>
            </li>
          ))}
        </ul>
        <hr className="rule" />
        <strong className="group-label">알아 둘 점</strong>
        <ul className="hint notes">
          <li>Avocado 를 켜 둔 채로 씁니다. 결과와 증적은 앱에서 실행한 것과 똑같이 결과 화면에 남습니다.</li>
          <li>
            <code>~/.local/bin</code> 이 PATH 에 없으면 <code>export PATH="$HOME/.local/bin:$PATH"</code> 를 <code>~/.zshrc</code> 에 넣습니다.
          </li>
          <li>실행은 한 번에 한 묶음입니다. 앱에서 차례 실행이 도는 동안에는 시작하지 않습니다.</li>
          <li>플로우가 있는 테스트 케이스만 돌립니다. 종료 코드: 0 통과 · 1 실패 · 2 인자 오류 · 3 앱이 꺼짐 · 4 취소 · 5 플로우 없음 · 6 시작 못 함</li>
        </ul>
        {message ? (
          <small role="status" className="hint">
            {message}
          </small>
        ) : null}
      </div>
    </section>
  );
}
