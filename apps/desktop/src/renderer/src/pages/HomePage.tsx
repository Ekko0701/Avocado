import type { AppInfo, AuthorJob, Build, Device, MyPullRequest, RunDetail, RunQueueStatus, RunSummary, SetupReport, TestcaseList, WorkBranchList, WorkspaceStatus } from "@qa/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { missingAccountValues } from "../lib/account-values";
import {
  attention,
  AUTHOR_PHASE_TEXT,
  dailyCounts,
  elapsed,
  flakyCount,
  flowCoverage,
  isActiveAuthor,
  isActiveRun,
  runProgress,
  shortDateTime,
  type DayCount,
} from "../lib/dashboard";
import { deviceLabel } from "../lib/device-label";
import { errorMessage } from "../lib/errors";
import { inProgressCount } from "../lib/git-state";
import { onWorkspaceChanged } from "../lib/workspace-events";

const RUN_STATUS: Record<RunSummary["status"], string> = { queued: "대기", running: "재생 중", passed: "통과", failed: "실패", error: "오류", canceled: "취소" };
const badge = (s: RunSummary["status"]) => (s === "passed" ? "badge ok" : s === "failed" || s === "error" ? "badge bad" : s === "running" || s === "queued" ? "badge live" : "badge");
/** 환경 점검은 xcodebuild·simctl 을 띄우므로 홈에 올 때마다 하지 않고 10분 동안 재사용한다 */
let setupCache: { at: number; report: Promise<SetupReport> } | null = null;
function cachedSetupCheck(): Promise<SetupReport> {
  if (!setupCache || Date.now() - setupCache.at > 10 * 60_000) {
    const report = window.qa.setup.check();
    setupCache = { at: Date.now(), report };
    report.catch(() => {
      setupCache = null;
    });
  }
  return setupCache.report;
}

export type HomeTarget = "workspace" | "devices" | "builds" | "accounts" | "runs" | "results" | "author" | "setup";

/**
 * 홈 대시보드(PLAN 12장): 지금 진행 중인 것(재생·차례 실행·플로우 만들기), 지표(실패 중·불안정·플로우 있는 테스트 케이스),
 * 최근 14일 추이, 환경, 살펴볼 테스트 케이스, 최근 실행. 버전·진단 정보는 설정 맨 아래에 있다.
 * 진행 중인 것이 있으면 2초마다, 없으면 8초마다 실행 상태를 다시 읽는다
 */
export function HomePage(props: { onNavigate: (to: HomeTarget) => void; onOpenResults: (runId: string) => void; onOpenInspector: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ws, setWs] = useState<WorkspaceStatus | null>(null);
  const [testcases, setTestcases] = useState<TestcaseList | null>(null);
  const [branches, setBranches] = useState<WorkBranchList | null>(null);
  const [pulls, setPulls] = useState<MyPullRequest[] | null>(null);
  const [missing, setMissing] = useState<number | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [setup, setSetup] = useState<SetupReport | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [queue, setQueue] = useState<RunQueueStatus | null>(null);
  const [author, setAuthor] = useState<AuthorJob | null>(null);
  /** 재생 중인 실행의 상세(스텝 진행) */
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);

  // 실행 상태: 자주 다시 읽는다(DB 만 읽는다)
  const loadLive = useCallback(async () => {
    const [r, q, a] = await Promise.allSettled([window.qa.runs.list(), window.qa.runs.queue(), window.qa.agent.currentAuthor()]);
    if (r.status === "fulfilled") {
      setRuns(r.value);
      const running = r.value.filter((x) => x.status === "running");
      const next: Record<string, RunDetail> = {};
      await Promise.all(running.map((x) => window.qa.runs.get({ runId: x.id }).then((d) => (next[x.id] = d), () => undefined)));
      setDetails(next);
    } else setError(errorMessage(r.reason));
    if (q.status === "fulfilled") setQueue(q.value);
    if (a.status === "fulfilled") setAuthor(a.value);
    setNow(new Date());
  }, []);

  // 그 밖의 것: 처음, 창에 돌아올 때, 다른 화면이 워크스페이스를 바꿨을 때. 섹션마다 따로 채운다(느린 호출이 다른 섹션을 막지 않게)
  const loadRest = useCallback(() => {
    window.qa.app.getInfo().then(setInfo, () => undefined);
    window.qa.devices.list().then((l) => setDevices(l.devices.filter((d) => d.state === "booted")), () => setDevices([]));
    window.qa.builds.list().then(setBuilds, () => setBuilds([]));
    cachedSetupCheck().then(setSetup, () => undefined);
    window.qa.workspace.status().then(
      (s) => {
        setWs(s);
        if (!s.connected) {
          setTestcases(null);
          setBranches(null);
          setPulls(null);
          return;
        }
        window.qa.workspace.testcases().then(setTestcases, () => setTestcases(null));
        window.qa.workspace.branches().then(setBranches, () => setBranches(null));
        window.qa.workspace.myPulls().then(setPulls, () => setPulls(null));
      },
      () => setWs(null),
    );
    Promise.all([window.qa.workspace.accounts(), window.qa.secrets.list()]).then(
      ([accounts, secrets]) => setMissing(missingAccountValues(accounts, secrets.items).length),
      () => setMissing(null),
    );
  }, []);

  useEffect(() => {
    void loadLive();
    loadRest();
    const changed = () => {
      void loadLive();
      loadRest();
    };
    const off = onWorkspaceChanged(changed);
    window.addEventListener("focus", changed);
    return () => {
      off();
      window.removeEventListener("focus", changed);
    };
  }, [loadLive, loadRest]);

  const active = (runs ?? []).filter(isActiveRun);
  const busy = active.length > 0 || (queue?.pending.length ?? 0) > 0 || isActiveAuthor(author);
  useEffect(() => {
    const timer = setInterval(() => void loadLive(), busy ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [busy, loadLive]);

  async function cancel(runId: string) {
    try {
      await window.qa.runs.cancel({ runId });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      await loadLive();
    }
  }

  async function clearQueue() {
    try {
      setQueue(await window.qa.runs.clearQueue());
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <h1>홈</h1>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {busy ? (
        <LiveCard
          runs={active}
          details={details}
          queue={queue}
          author={isActiveAuthor(author) ? author : null}
          now={now}
          onCancel={(id) => void cancel(id)}
          onClearQueue={() => void clearQueue()}
          onNavigate={props.onNavigate}
        />
      ) : null}
      <Tiles runs={runs} testcases={ws?.connected ? testcases : null} connected={ws?.connected ?? false} now={now} />
      <div className="home-two">
        <TrendCard runs={runs} now={now} />
        <EnvCard
          devices={devices}
          builds={builds}
          ws={ws}
          inProgress={branches ? inProgressCount(branches.branches) : null}
          pulls={pulls}
          missing={missing}
          setup={setup}
          onNavigate={props.onNavigate}
          onOpenInspector={props.onOpenInspector}
        />
      </div>
      <div className="home-two">
        <AttentionCard runs={runs} onOpenResults={props.onOpenResults} onNavigate={props.onNavigate} />
        <RecentCard runs={runs} onOpenResults={props.onOpenResults} onNavigate={props.onNavigate} />
      </div>
      <p className="hint home-foot">
        Avocado <span data-testid="app-version">{info?.version ?? ""}</span> · 버전과 진단 정보는 설정 맨 아래 &quot;앱 정보&quot;에 있습니다.
      </p>
    </>
  );
}

function LiveCard(props: {
  runs: RunSummary[];
  details: Record<string, RunDetail>;
  queue: RunQueueStatus | null;
  author: AuthorJob | null;
  now: Date;
  onCancel: (runId: string) => void;
  onClearQueue: () => void;
  onNavigate: (to: HomeTarget) => void;
}) {
  const pending = props.queue?.pending ?? [];
  const counts = [props.runs.length > 0 ? `재생 ${props.runs.length}` : null, pending.length > 0 ? `대기 ${pending.length}` : null, props.author ? "플로우 만들기 1" : null].filter(Boolean);
  return (
    <section className="card stack" aria-label="지금 진행 중" data-testid="home-live">
      <div className="card-head">
        <h2>지금 진행 중</h2>
        <span className="hint home-small">{counts.join(" · ")}</span>
        <button type="button" className="link" onClick={() => props.onNavigate("runs")}>
          실행 열기
        </button>
      </div>
      <ul className="home-live">
        {props.runs.map((r) => {
          const progress = props.details[r.id] ? runProgress(props.details[r.id] as RunDetail) : null;
          const attempt = progress?.attempt ?? props.details[r.id]?.executions.at(-1)?.attempt ?? 1;
          return (
            <li key={r.id} data-testid={`home-live-run-${r.id}`}>
              <span className="badge live">{RUN_STATUS[r.status]}</span>
              <div className="home-live-body">
                <div className="home-live-title">
                  <strong>{r.flowName.includes(r.tcId) ? r.flowName : `${r.tcId} ${r.flowName}`}</strong>
                  <span className="hint home-small">
                    {r.target} · {r.deviceName} · {attempt}회차 · {elapsed(r.startedAt ?? r.createdAt, props.now)}째
                  </span>
                </div>
                {progress ? (
                  <>
                    <div className="home-progress" role="progressbar" aria-label={`스텝 ${progress.done}/${progress.total}`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                      <div style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                    </div>
                    <span className="hint home-small">
                      스텝 {progress.done}/{progress.total}
                      {progress.current ? ` · ${progress.current}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="hint home-small">{r.status === "queued" ? "기기를 준비하는 중" : "Maestro 가 재생하는 중 · 스텝 기록은 회차가 끝나면 보입니다"}</span>
                )}
              </div>
              <div className="row center">
                <button type="button" className="secondary small" onClick={() => props.onNavigate("runs")}>
                  스텝 보기
                </button>
                <button type="button" className="secondary small" onClick={() => props.onCancel(r.id)}>
                  취소
                </button>
              </div>
            </li>
          );
        })}
        {pending.length > 0 ? (
          <li data-testid="home-live-queue">
            <span className="badge">대기 {pending.length}</span>
            <div className="home-live-body">
              <strong>차례 실행</strong>
              <span className="hint home-small">다음: {pending.join(" → ")} · 앞의 실행이 끝나면 같은 기기에서 시작합니다</span>
            </div>
            <button type="button" className="secondary small" onClick={props.onClearQueue}>
              차례 실행 비우기
            </button>
          </li>
        ) : null}
        {props.author ? (
          <li data-testid="home-live-author">
            <span className="badge live">플로우 만들기</span>
            <div className="home-live-body">
              <strong>{props.author.tcId}</strong>
              <span className="hint home-small">
                {props.author.app} · {props.author.target} · {AUTHOR_PHASE_TEXT[props.author.phase]}
                {props.author.step > 0 ? ` · 스텝 ${props.author.step}` : ""} · {elapsed(props.author.job.createdAt, props.now)}째
              </span>
            </div>
            <button type="button" className="secondary small" onClick={() => props.onNavigate("author")}>
              플로우 만들기 열기
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function Tile(props: { label: string; value: string; sub: string; tone?: "ok" | "bad"; testId: string }) {
  return (
    <section className={props.tone ? `card home-tile ${props.tone}` : "card home-tile"} aria-label={props.label} data-testid={props.testId}>
      <span className="home-tile-label">{props.label}</span>
      <span className="home-tile-value">{props.value}</span>
      <span className="hint home-small">{props.sub}</span>
    </section>
  );
}

function Tiles(props: { runs: RunSummary[] | null; testcases: TestcaseList | null; connected: boolean; now: Date }) {
  const runs = props.runs ?? [];
  const failing = attention(runs).filter((a) => a.streak > 0).length;
  const flaky = flakyCount(runs, props.now);
  const coverage = props.testcases ? flowCoverage(props.testcases) : null;
  const none = runs.every((r) => isActiveRun(r) || r.status === "canceled");
  return (
    <div className="home-tiles">
      <Tile testId="home-tile-failing" label="지금 실패 중" value={none ? "-" : String(failing)} sub="테스트 케이스·타깃 · 마지막 결과 기준" tone={failing > 0 ? "bad" : undefined} />
      <Tile testId="home-tile-flaky" label="불안정" value={none ? "-" : String(flaky)} sub="다시 실행해야 통과한 실행 · 7일" />
      <Tile
        testId="home-tile-coverage"
        label="플로우 있는 테스트 케이스"
        value={coverage ? `${coverage.withFlow} / ${coverage.total}` : "-"}
        sub={
          coverage
            ? Object.entries(coverage.byTarget)
                .map(([t, c]) => `${t} ${c}`)
                .join(" · ") || "아직 플로우가 없습니다"
            : props.connected
              ? "불러오는 중"
              : "워크스페이스를 연결하면 보입니다"
        }
      />
    </div>
  );
}

/** 날짜 칸 이름: "11.4" */
const shortDay = (day: string) => {
  const [, m, d] = day.split("-");
  return `${Number(m)}.${Number(d)}`;
};

function TrendCard(props: { runs: RunSummary[] | null; now: Date }) {
  const days = useMemo(() => dailyCounts(props.runs ?? [], props.now), [props.runs, props.now]);
  const empty = days.every((d) => d.passed + d.failed === 0);
  return (
    <section className="card stack" aria-label="최근 14일 실행" data-testid="home-trend">
      <div className="card-head">
        <h2>최근 14일 실행</h2>
        {empty ? null : (
          <div className="home-legend" aria-hidden="true">
            <span>
              <i className="home-swatch pass" />
              통과
            </span>
            <span>
              <i className="home-swatch fail" />
              실패·오류
            </span>
          </div>
        )}
      </div>
      {empty ? <p className="hint home-trend-empty">실행 기록이 쌓이면 날마다 통과·실패 수가 여기에 보입니다.</p> : <TrendChart days={days} />}
    </section>
  );
}

/** 날마다 통과(아래)·실패(위, 빗금)를 쌓은 막대. 빨강·초록은 색각 이상에서 구분되지 않아 무늬·위치·범례로도 구분한다. 막대에 올리면 그날 수가 보인다 */
function TrendChart(props: { days: DayCount[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 600;
  const h = 210;
  const left = 30;
  const bottom = 26;
  const top = 10;
  const plot = h - bottom - top;
  const most = Math.max(1, ...props.days.map((d) => d.passed + d.failed));
  const tick = most <= 4 ? 1 : most <= 10 ? 2 : Math.ceil(most / 5);
  const max = Math.ceil(most / tick) * tick;
  const y = (v: number) => top + plot - (v / max) * plot;
  const step = (w - left - 6) / props.days.length;
  const bar = Math.min(22, step * 0.6);
  const ticks = Array.from({ length: max / tick + 1 }, (_, i) => i * tick);
  const hovered = hover === null ? null : props.days[hover];
  return (
    <div className="home-chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`최근 14일 실행: ${props.days.map((d) => `${shortDay(d.day)} 통과 ${d.passed} 실패 ${d.failed}`).join(", ")}`}>
        <defs>
          <pattern id="home-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" style={{ fill: "var(--danger)" }} />
            <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--chart-gap)", strokeWidth: 2 }} />
          </pattern>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left} x2={w - 2} y1={y(v)} y2={y(v)} className={v === 0 ? "home-axis" : "home-grid"} />
            <text x={left - 8} y={y(v) + 4} textAnchor="end" className="home-tick">
              {v}
            </text>
          </g>
        ))}
        {props.days.map((d, k) => {
          const x = left + k * step + (step - bar) / 2;
          const passTop = y(d.passed);
          const failBase = passTop - (d.passed > 0 && d.failed > 0 ? 2 : 0);
          const failTop = failBase - (y(0) - y(d.failed));
          return (
            <g key={d.day}>
              {d.passed > 0 ? <rect x={x} y={passTop} width={bar} height={y(0) - passTop} rx={2} style={{ fill: "var(--success)" }} /> : null}
              {d.failed > 0 ? <rect x={x} y={failTop} width={bar} height={failBase - failTop} rx={2} fill="url(#home-hatch)" /> : null}
              {k % 2 === 1 || k === props.days.length - 1 ? (
                <text x={x + bar / 2} y={h - 8} textAnchor="middle" className="home-tick">
                  {shortDay(d.day)}
                </text>
              ) : null}
              {/* 막대보다 넓은 손잡이(빈 날에도 올릴 수 있다) */}
              <rect
                x={left + k * step}
                y={top}
                width={step}
                height={plot}
                className="home-hit"
                data-testid={`home-trend-day-${d.day}`}
                onMouseEnter={() => setHover(k)}
                onMouseLeave={() => setHover((cur) => (cur === k ? null : cur))}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null ? (
        <div
          className={hover >= props.days.length - 3 ? "home-tooltip end" : hover <= 1 ? "home-tooltip start" : "home-tooltip"}
          role="status"
          style={{ left: `${((left + hover * step + step / 2) / w) * 100}%` }}
        >
          <strong>{shortDay(hovered.day)}</strong>
          <span>통과 {hovered.passed}</span>
          <span>실패·오류 {hovered.failed}</span>
        </div>
      ) : null}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad";
const TONE_TEXT: Record<Tone, string> = { ok: "정상", warn: "확인", bad: "필요" };

function EnvRow(props: { label: string; value: string; tone: Tone; action?: { label: string; onClick: () => void }; testId: string }) {
  return (
    <li data-testid={props.testId}>
      <span className={`badge ${props.tone === "ok" ? "ok" : props.tone === "bad" ? "bad" : "warn"}`}>{TONE_TEXT[props.tone]}</span>
      <div className="home-env-body">
        <strong>{props.label}</strong>
        <span className="hint home-small" title={props.value}>
          {props.value}
        </span>
      </div>
      {props.action ? (
        <button type="button" className="link home-small" onClick={props.action.onClick}>
          {props.action.label}
        </button>
      ) : null}
    </li>
  );
}

function EnvCard(props: {
  devices: Device[] | null;
  builds: Build[] | null;
  ws: WorkspaceStatus | null;
  inProgress: number | null;
  pulls: MyPullRequest[] | null;
  missing: number | null;
  setup: SetupReport | null;
  onNavigate: (to: HomeTarget) => void;
  onOpenInspector: () => void;
}) {
  const go = (to: HomeTarget, label: string) => ({ label, onClick: () => props.onNavigate(to) });
  const { devices, builds, ws, setup } = props;
  const latest = builds?.[0];
  const required = setup?.checks.filter((c) => c.status === "fail" && c.required) ?? [];
  const warned = setup?.checks.filter((c) => c.status !== "ok" && !(c.status === "fail" && c.required)) ?? [];
  const tools = setup?.tools.map((t) => `${t.id === "jre" ? "Java" : "Maestro"} ${t.version}${t.installed ? "" : " 없음"}`).join(" · ") ?? "확인 중";
  const sync = ws?.connected ? [ws.behind > 0 ? `원격보다 ${ws.behind}개 뒤` : null, ws.ahead > 0 ? `올리지 않은 커밋 ${ws.ahead}개` : null, ws.issues > 0 ? `파일 문제 ${ws.issues}개` : null].filter(Boolean) : [];
  return (
    <section className="card stack" aria-label="환경" data-testid="home-env">
      <h2>환경</h2>
      <ul className="home-env">
        <EnvRow
          testId="home-env-tools"
          label="도구·점검"
          tone={required.length > 0 ? "bad" : warned.length > 0 ? "warn" : "ok"}
          value={required.length > 0 ? required.map((c) => `${c.label} ${c.detail}`).join(" · ") : warned.length > 0 ? warned.map((c) => c.label).join(" · ") : tools}
          action={required.length > 0 || warned.length > 0 ? go("setup", "설정 마법사 열기") : undefined}
        />
        <EnvRow
          testId="home-workspace"
          label="워크스페이스"
          tone={ws?.connected ? (ws.issues > 0 ? "warn" : "ok") : ws?.repo ? "warn" : "bad"}
          value={
            ws?.connected
              ? `${ws.repo} · ${ws.branch}${sync.length > 0 ? ` · ${sync.join(" · ")}` : " · 원격과 같음"}`
              : ws?.repo
                ? `${ws.repo} 를 아직 연결하지 않았습니다`
                : "설정에서 GitHub 조직을 정하면 연결할 수 있습니다"
          }
          action={go("workspace", "워크스페이스 열기")}
        />
        <EnvRow
          testId="home-env-devices"
          label="기기"
          tone={devices && devices.length > 0 ? "ok" : "warn"}
          value={devices === null ? "확인 중" : devices.length > 0 ? `${devices.map(deviceLabel).join(", ")} 실행 중` : "실행 중인 기기가 없습니다"}
          action={go("devices", "기기 열기")}
        />
        <EnvRow
          testId="home-env-builds"
          label="빌드"
          tone={builds && builds.length > 0 ? "ok" : "warn"}
          value={builds === null ? "확인 중" : latest ? `${builds.length}개 · 최근 ${latest.app} ${latest.version} (${latest.buildNumber}) · ${shortDateTime(latest.createdAt)}` : "등록한 빌드가 없습니다"}
          action={go("builds", "빌드 열기")}
        />
        {ws?.connected ? (
          <EnvRow
            testId="home-pulls"
            label="진행 중인 작업"
            tone={(props.inProgress ?? 0) > 0 ? "warn" : "ok"}
            value={`${props.inProgress === null ? "확인 중" : props.inProgress > 0 ? `main 에 없는 작업 브랜치 ${props.inProgress}개` : "올릴 작업 없음"} · ${props.pulls === null ? "PR 을 읽지 못함" : `열린 PR ${props.pulls.length}개`}`}
            action={{ label: "Git 상태 열기", onClick: props.onOpenInspector }}
          />
        ) : null}
        {props.missing !== null && props.missing > 0 ? (
          <EnvRow testId="home-env-accounts" label="테스트 계정" tone="warn" value={`값을 넣지 않은 키 ${props.missing}개`} action={go("accounts", "테스트 계정 열기")} />
        ) : null}
      </ul>
    </section>
  );
}

function AttentionCard(props: { runs: RunSummary[] | null; onOpenResults: (runId: string) => void; onNavigate: (to: HomeTarget) => void }) {
  const items = attention(props.runs ?? []).slice(0, 6);
  return (
    <section className="card stack" aria-label="살펴볼 테스트 케이스" data-testid="home-attention">
      <div className="card-head">
        <h2>살펴볼 테스트 케이스</h2>
        <span className="hint home-small">마지막 결과가 실패이거나 다시 실행해야 통과한 것</span>
        <button type="button" className="link" onClick={() => props.onNavigate("results")}>
          결과 전체 보기
        </button>
      </div>
      {items.length === 0 ? (
        <p className="hint">{props.runs && props.runs.length > 0 ? "살펴볼 테스트 케이스가 없습니다. 마지막 결과가 모두 통과입니다." : "실행 기록이 없습니다."}</p>
      ) : (
        <table className="matrix home-attention-table">
          <thead>
            <tr>
              <th>테스트 케이스</th>
              <th>타깃</th>
              <th>마지막 결과</th>
              <th>연속</th>
              <th>마지막 실행</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={`${a.tcId}-${a.target}`} data-testid={`home-attention-${a.tcId}-${a.target}`}>
                <td>
                  <strong>{a.tcId}</strong> <span className="hint">{a.latest.flowName.replace(a.tcId, "").trim()}</span>
                </td>
                <td>{a.target}</td>
                <td>
                  <span className={a.streak > 0 ? "badge bad" : "badge ok"}>{a.streak > 0 ? RUN_STATUS[a.latest.status] : "재시도 통과"}</span>
                </td>
                <td className="num">{a.streak > 0 ? `${a.streak}회` : "-"}</td>
                <td className="hint nowrap">{shortDateTime(a.latest.createdAt)}</td>
                <td>
                  <button type="button" className="secondary small nowrap" aria-label={`${a.tcId} ${a.target} 결과 보기`} onClick={() => props.onOpenResults(a.latest.id)}>
                    결과 보기
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RecentCard(props: { runs: RunSummary[] | null; onOpenResults: (runId: string) => void; onNavigate: (to: HomeTarget) => void }) {
  const recent = (props.runs ?? []).slice(0, 5);
  return (
    <section className="card stack" aria-label="최근 실행" data-testid="home-runs">
      <div className="card-head">
        <h2>최근 실행</h2>
        <button type="button" className="link" onClick={() => props.onNavigate("runs")}>
          실행 열기
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="hint">실행 기록이 없습니다.</p>
      ) : (
        <ul className="checks">
          {recent.map((r) => (
            <li key={r.id} className="check home-recent">
              <span className={badge(r.status)}>{RUN_STATUS[r.status]}</span>
              <div className="check-body">
                {isActiveRun(r) ? (
                  <strong>{r.flowName}</strong>
                ) : (
                  <button type="button" className="link home-recent-name" onClick={() => props.onOpenResults(r.id)}>
                    {r.flowName}
                  </button>
                )}
                <small className="hint">
                  {r.target} · {r.deviceName} · {shortDateTime(r.createdAt)}
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
