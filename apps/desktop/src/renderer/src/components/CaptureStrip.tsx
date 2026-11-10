import type { RunStep } from "@qa/shared";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";

/**
 * 한 시도(execution)의 캡처를 스텝 순서대로 한 줄에 모아 보인다. 누르면 그 스텝을 고른다.
 * 가린 사본에서 읽는다(evidence.file). 실패 캡처가 있으면 그것을, 없으면 플로우가 찍은 캡처를 보인다
 */
export function CaptureStrip(props: { runId: string; executionId: string; steps: RunStep[]; selected: number | null; onSelect: (index: number) => void }) {
  const shots = props.steps.flatMap((s) => {
    const path = s.failureScreenshot ?? s.screenshot;
    return path ? [{ index: s.index, path, failed: s.failureScreenshot !== null, label: s.description }] : [];
  });
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // 캡처 경로를 이은 값. 목록이 바뀌었을 때만 다시 읽는다
  const key = shots.map((s) => s.path).join("|");

  useEffect(() => {
    setImages({});
    setError(null);
    let stale = false;
    for (const path of key ? key.split("|") : []) {
      window.qa.evidence.file({ runId: props.runId, executionId: props.executionId, path }).then(
        (f) => {
          if (!stale && f.kind === "image") setImages((prev) => ({ ...prev, [path]: f.dataUrl }));
        },
        (e: unknown) => !stale && setError(errorMessage(e)),
      );
    }
    return () => {
      stale = true;
    };
  }, [props.runId, props.executionId, key]);

  if (shots.length === 0) return null;
  return (
    <section className="card stack" aria-label="캡처 모아 보기" data-testid="capture-strip">
      <h2>캡처 {shots.length}장</h2>
      <ol className="capture-strip">
        {shots.map((s) => (
          <li key={s.path}>
            <button
              type="button"
              className={s.index === props.selected ? "capture-thumb selected" : "capture-thumb"}
              aria-pressed={s.index === props.selected}
              aria-label={`${s.index + 1}. ${s.label} 캡처 보기`}
              onClick={() => props.onSelect(s.index)}
            >
              {images[s.path] ? <img src={images[s.path]} alt="" /> : <span className="hint">불러오는 중</span>}
              <small className={s.failed ? "error" : "hint"}>
                {s.index + 1}. {s.failed ? "실패 캡처" : fileLabel(s.path)}
              </small>
            </button>
          </li>
        ))}
      </ol>
      {error ? (
        <p role="alert" className="error">
          캡처를 읽지 못했습니다: {error}
        </p>
      ) : null}
    </section>
  );
}

function fileLabel(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.(png|jpe?g)$/i, "");
}
