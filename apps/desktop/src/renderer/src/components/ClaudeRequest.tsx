import { useState } from "react";
import { errorMessage } from "../lib/errors";

/** Claude 앱 방식(ADR 0022): Claude 데스크톱 앱이나 Claude Code 에 붙여 넣을 요청과 복사 버튼 */
export function ClaudeRequest(props: { text: string; hint: string; testId: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="stack" data-testid={props.testId}>
      <p className="hint">{props.hint}</p>
      <div className="row">
        <code className="grow" data-testid={`${props.testId}-text`}>
          {props.text}
        </code>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void navigator.clipboard.writeText(props.text).then(
              () => setCopied("복사했습니다"),
              (e: unknown) => setCopied(`복사하지 못했습니다(글자를 직접 선택해 복사합니다): ${errorMessage(e)}`),
            )
          }
        >
          복사
        </button>
        {copied ? (
          <small role="status" className="hint">
            {copied}
          </small>
        ) : null}
      </div>
    </div>
  );
}
