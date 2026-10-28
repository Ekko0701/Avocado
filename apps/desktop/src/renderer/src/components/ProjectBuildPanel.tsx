import type { Build, IosProject, ProjectStatus } from "@qa/shared";
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "../lib/errors";

const TOOL_TEXT: Record<IosProject["tools"][number], string> = { tuist: "Tuist", xcodegen: "XcodeGen", cocoapods: "CocoaPods" };

/** 팀 값 → 이 Mac 의 마지막 값 → 목록의 기본(첫 번째 또는 prefer) 순으로 고른다(ADR 0025) */
function pick(options: string[], ...candidates: (string | null | undefined)[]): string {
  return candidates.find((c): c is string => !!c && options.includes(c)) ?? options[0] ?? "";
}

const baseName = (path: string | null) => (path ? (path.split("/").pop() ?? path) : "");

/**
 * 프로젝트 폴더로 빌드(iOS, ADR 0025). 폴더는 이 Mac 에만 저장하고, 스킴·구성의 팀 기본값은 워크스페이스 앱 설정에서 온다.
 * 빌드는 수 분 걸려 경과 시간을 보여 준다
 */
export function ProjectBuildPanel(props: { app: string; disabled: boolean; onBusy: (busy: boolean) => void; onBuilt: (build: Build) => void }) {
  const { app } = props;
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [scheme, setScheme] = useState("");
  const [configuration, setConfiguration] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // 앱 ID 를 치는 동안 매번 xcodebuild -list 를 돌리지 않게 잠깐 기다린 뒤 읽는다
  useEffect(() => {
    setStatus(null);
    setMessage(null);
    const timer = setTimeout(() => {
      window.qa.builds.projectStatus({ app }).then(setStatus, (e: unknown) => setMessage(errorMessage(e)));
    }, 400);
    return () => clearTimeout(timer);
  }, [app]);

  const ios = status?.app === app ? status.ios : null;
  useEffect(() => {
    if (!ios) return;
    setScheme(pick(ios.schemes, ios.teamScheme, ios.scheme));
    setConfiguration(pick(ios.configurations, ios.teamConfiguration, ios.configuration, "Debug"));
  }, [ios]);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  async function act<T>(label: string, action: () => Promise<T>, done: (result: T) => string | null) {
    setBusy(label);
    props.onBusy(true);
    setMessage(null);
    try {
      setMessage(done(await action()));
    } catch (e) {
      setMessage(`${label} 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
      setStartedAt(null);
      props.onBusy(false);
    }
  }

  const link = () =>
    act("연결", () => window.qa.builds.linkProject({ app }), (s) => {
      if (!s) return null;
      setStatus(s);
      return s.ios?.problem ? null : `연결했습니다: ${s.ios?.path ?? ""}`;
    });
  const reread = () =>
    act("스킴 읽기", () => window.qa.builds.projectStatus({ app, prepare: true }), (s) => {
      setStatus(s);
      return s.ios && !s.ios.problem ? `스킴 ${s.ios.schemes.length}개를 읽었습니다` : null;
    });
  const unlink = () => act("연결 해제", () => window.qa.builds.unlinkProject({ app }), (s) => (setStatus(s), "연결을 해제했습니다(프로젝트 폴더는 그대로입니다)"));
  const build = () => {
    setStartedAt(Date.now());
    setNow(Date.now());
    return act("빌드", () => window.qa.builds.buildProject({ app, scheme, configuration }), (b) => {
      props.onBuilt(b);
      // 마지막으로 고른 값이 바뀌었다
      void window.qa.builds.projectStatus({ app }).then(setStatus, () => undefined);
      return `등록했습니다: ${b.appId} ${b.version} (${b.buildNumber}) · ${b.label ?? ""}`;
    });
  };

  const elapsed = startedAt === null ? "" : `${Math.floor((now - startedAt) / 60_000)}분 ${Math.floor(((now - startedAt) % 60_000) / 1000)}초`;
  const locked = props.disabled || busy !== null;
  const tools = useMemo(() => (ios?.tools ?? []).map((t) => TOOL_TEXT[t]).join(", "), [ios]);

  return (
    <section className="card stack" aria-label="프로젝트로 빌드" data-testid="project-build">
      <h2>프로젝트로 빌드 (iOS)</h2>
      <p className="hint">
        Xcode 프로젝트 폴더를 연결하면 Avocado 가 시뮬레이터용으로 빌드해 등록합니다. 폴더 위치는 이 Mac 에만 저장합니다. 지금 폴더의 코드(커밋하지 않은 변경 포함)로
        빌드하고, Tuist·XcodeGen·CocoaPods 프로젝트는 빌드 전에 프로젝트 폴더에서 생성·pod install 을 합니다.
      </p>
      {status === null && !message ? <p className="hint">불러오는 중</p> : null}
      {status !== null && !ios ? (
        <div className="row">
          <button type="button" disabled={locked} onClick={() => void link()}>
            {busy === "연결" ? "연결 중" : "프로젝트 연결"}
          </button>
        </div>
      ) : null}
      {ios ? (
        <>
          <dl data-testid="project-info">
            <dt>폴더</dt>
            <dd>
              <code>{ios.path}</code>
            </dd>
            <dt>프로젝트</dt>
            <dd>
              {baseName(ios.container) || "생성 전"}
              {tools ? ` · ${tools}` : ""}
            </dd>
            <dt>커밋</dt>
            <dd>{ios.git ? `${ios.git.commit.slice(0, 10)}${ios.git.changes > 0 ? ` · 커밋 안 한 변경 ${ios.git.changes}개 포함` : ""}` : "git 저장소 아님"}</dd>
          </dl>
          {ios.problem ? (
            <p className="warning" role="alert">
              {ios.problem}
            </p>
          ) : null}
          <div className="row">
            <label>
              스킴
              <select aria-label="스킴" value={scheme} onChange={(e) => setScheme(e.target.value)} disabled={locked || ios.schemes.length === 0}>
                {ios.schemes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                    {s === ios.teamScheme ? " (팀 기본값)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              구성
              <select aria-label="구성" value={configuration} onChange={(e) => setConfiguration(e.target.value)} disabled={locked}>
                {ios.configurations.map((c) => (
                  <option key={c} value={c}>
                    {c}
                    {c === ios.teamConfiguration ? " (팀 기본값)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={locked || !scheme || !configuration} onClick={() => void build()}>
              {busy === "빌드" ? `빌드 중 · ${elapsed}` : "빌드 시작"}
            </button>
          </div>
          {busy === "빌드" ? <small className="hint">첫 빌드는 몇 분 걸립니다. 다음부터는 바뀐 부분만 빌드해 빨라집니다.</small> : null}
          <div className="row">
            <button type="button" className="secondary" disabled={locked} onClick={() => void reread()}>
              {busy === "스킴 읽기" ? "읽는 중" : "스킴 다시 읽기"}
            </button>
            <button type="button" className="secondary" disabled={locked} onClick={() => void link()}>
              다른 폴더 연결
            </button>
            <button type="button" className="secondary" disabled={locked} onClick={() => void unlink()}>
              연결 해제
            </button>
          </div>
        </>
      ) : null}
      {message ? (
        <p role="status" data-testid="project-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
