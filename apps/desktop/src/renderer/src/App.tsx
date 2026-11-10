import { useCallback, useEffect, useState } from "react";
import { GitInspector } from "./components/GitInspector";
import { Icon, type IconName } from "./components/Icon";
import { Toolbar } from "./components/Toolbar";
import { UpdateBanner } from "./components/UpdateBanner";
import { AuthorPage } from "./pages/AuthorPage";
import { BuildsPage } from "./pages/BuildsPage";
import { DevicesPage } from "./pages/DevicesPage";
import { HomePage } from "./pages/HomePage";
import { ResultsPage } from "./pages/ResultsPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TestcasesPage } from "./pages/TestcasesPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { SetupWizard } from "./pages/SetupWizard";
import { TestAccountsPage } from "./pages/TestAccountsPage";
import { missingAccountValues } from "./lib/account-values";
import { onWorkspaceChanged } from "./lib/workspace-events";

type Page = "home" | "workspace" | "testcases" | "author" | "runs" | "results" | "accounts" | "devices" | "builds" | "settings" | "setup";

/** 사이드바 구역(Fork 의 Branches·Remotes 처럼 작은 머리글로 묶는다). 머리글은 제목 요소가 아니다 */
const NAV: { group: string | null; items: { id: Page; label: string; icon: IconName }[] }[] = [
  { group: null, items: [{ id: "home", label: "홈", icon: "home" }] },
  {
    group: "작성",
    items: [
      { id: "testcases", label: "테스트 케이스", icon: "doc" },
      { id: "author", label: "플로우 만들기", icon: "sparkle" },
    ],
  },
  {
    group: "검증",
    items: [
      { id: "runs", label: "실행", icon: "play" },
      { id: "results", label: "결과", icon: "chart" },
      // 플로우가 ${KEY} 로 쓰는 값. 실행하려면 갖춰야 해서 실행·결과 옆에 둔다
      { id: "accounts", label: "테스트 계정", icon: "key" },
    ],
  },
  {
    group: "환경",
    items: [
      { id: "devices", label: "기기", icon: "phone" },
      { id: "builds", label: "빌드", icon: "box" },
    ],
  },
  {
    group: "앱",
    items: [
      // TC·플로우 저장소의 연결·브랜치 상태를 보는 설정 성격의 화면이라 앱 구역에 둔다
      { id: "workspace", label: "워크스페이스", icon: "folder" },
      { id: "setup", label: "설정 마법사", icon: "wand" },
      { id: "settings", label: "설정", icon: "gear" },
    ],
  },
];

export function App() {
  const [page, setPage] = useState<Page | null>(null);
  const [resultsRunId, setResultsRunId] = useState<string | null>(null);
  /** 오른쪽 Git 상태 인스펙터. 화면을 옮겨도 열린 채로 둔다 */
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // 마법사를 끝내지 않았으면 마법사부터 연다.
  useEffect(() => {
    window.qa.settings
      .get()
      .then((state) => setPage(state.settings.setup.completedAt ? "home" : "setup"))
      .catch(() => setPage("home"));
  }, []);

  // 사이드바 테스트 계정 배지: accounts.yaml 에 키가 있는데 값이 없는 수
  const [missingAccounts, setMissingAccounts] = useState(0);
  const refreshMissing = useCallback(() => {
    Promise.all([window.qa.workspace.accounts(), window.qa.secrets.list()]).then(
      ([accounts, secrets]) => setMissingAccounts(missingAccountValues(accounts, secrets.items).length),
      () => setMissingAccounts(0),
    );
  }, []);
  useEffect(() => {
    refreshMissing();
    const timer = setInterval(refreshMissing, 8000);
    const off = onWorkspaceChanged(refreshMissing);
    window.addEventListener("focus", refreshMissing);
    return () => {
      clearInterval(timer);
      off();
      window.removeEventListener("focus", refreshMissing);
    };
  }, [refreshMissing]);
  useEffect(refreshMissing, [page, refreshMissing]);

  function go(next: Page) {
    setResultsRunId(null);
    setPage(next);
  }

  return (
    <div className={inspectorOpen ? "window with-inspector" : "window"}>
      {/* 떠 있는 유리 사이드바. 머리는 신호등 버튼 자리이자 창 끌기 영역이다 */}
      <aside className="sidebar glass">
        <div className="sidebar-head" />
        <nav className="sidebar-nav" aria-label="주 메뉴">
          {NAV.map((section) => (
            <div key={section.group ?? "top"} className="nav-group">
              {section.group ? <div className="nav-section">{section.group}</div> : null}
              {section.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={page === item.id ? "nav-item active" : "nav-item"}
                  aria-current={page === item.id ? "page" : undefined}
                  onClick={() => go(item.id)}
                >
                  <Icon name={item.icon} />
                  {item.label}
                  {item.id === "accounts" && missingAccounts > 0 ? (
                    <span className="nav-badge" data-testid="nav-badge-accounts" title={`값을 넣지 않은 테스트 계정 키 ${missingAccounts}개`} aria-hidden="true">
                      {missingAccounts}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="main">
        <Toolbar page={page} onNavigate={go} inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen((open) => !open)} />
        <main className={page === "home" ? "content wide" : page === "testcases" || page === "results" || page === "author" || page === "settings" || page === "workspace" || page === "accounts" || page === "devices" || page === "builds" || page === "setup" ? "content fill" : "content"}>
          <UpdateBanner />
          {page === "home" ? (
            <HomePage
              onNavigate={go}
              onOpenResults={(runId) => {
                setResultsRunId(runId);
                setPage("results");
              }}
              onOpenInspector={() => setInspectorOpen(true)}
            />
          ) : null}
          {page === "workspace" ? <WorkspacePage onOpenInspector={() => setInspectorOpen(true)} onOpenSettings={() => go("settings")} /> : null}
          {page === "testcases" ? <TestcasesPage /> : null}
          {page === "author" ? (
            <AuthorPage
              onOpenResults={(runId) => {
                setResultsRunId(runId);
                setPage("results");
              }}
            />
          ) : null}
          {page === "runs" ? (
            <RunsPage
              onOpenResults={(runId) => {
                setResultsRunId(runId);
                setPage("results");
              }}
            />
          ) : null}
          {page === "results" ? <ResultsPage key={resultsRunId ?? "none"} initialRunId={resultsRunId} onOpenRuns={() => go("runs")} /> : null}
          {page === "accounts" ? <TestAccountsPage onOpenWorkspace={() => go("workspace")} onChanged={refreshMissing} /> : null}
          {page === "devices" ? <DevicesPage /> : null}
          {page === "builds" ? <BuildsPage /> : null}
          {page === "settings" ? <SettingsPage /> : null}
          {page === "setup" ? <SetupWizard onFinished={() => setPage("home")} onClose={() => setPage("home")} /> : null}
        </main>
      </div>
      {inspectorOpen ? <GitInspector onClose={() => setInspectorOpen(false)} /> : null}
    </div>
  );
}
