import type { SecretStatus } from "@qa/shared";
import { useState, type FormEvent } from "react";
import { errorMessage, formatDateTime } from "../lib/errors";

/** 비밀 한 개의 저장·삭제 행. 저장한 값은 다시 표시하지 않는다(값을 읽는 API 가 없다). */
export function SecretRow(props: { status: SecretStatus; label: string; disabled: boolean; onChanged: () => Promise<void> }) {
  const { status, label, disabled, onChanged } = props;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await window.qa.secrets.set({ name: status.name, value: trimmed });
      setValue("");
      setMessage("저장했습니다");
      await onChanged();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await window.qa.secrets.delete({ name: status.name });
      setMessage("삭제했습니다");
      await onChanged();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="secret-row" onSubmit={save} data-testid={`secret-${status.name}`}>
      <div className="secret-label">
        <strong>{label}</strong>
        <span className={status.stored ? "badge ok" : "badge"} data-testid="secret-status">
          {status.stored ? "저장됨" : "저장 안 됨"}
        </span>
        {status.updatedAt ? <small className="hint">{formatDateTime(status.updatedAt)}</small> : null}
      </div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${label} 입력`}
        placeholder={status.stored ? "새 값으로 바꾸기" : "값 입력"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled || busy}
      />
      <button type="submit" disabled={disabled || busy || value.trim() === ""}>
        저장
      </button>
      {status.stored ? (
        <button type="button" className="secondary" onClick={() => void remove()} disabled={busy}>
          삭제
        </button>
      ) : null}
      {message ? (
        <small role="status" className="hint">
          {message}
        </small>
      ) : null}
    </form>
  );
}
