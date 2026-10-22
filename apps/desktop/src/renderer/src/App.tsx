import { useEffect, useState } from "react";
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

type Page = "home" | "workspace" | "testcases" | "author" | "runs" | "results" | "devices" | "builds" | "settings" | "setup";

/** 사이드바 구역(Fork 의 Branches·Remotes 처럼 작은 머리글로 묶는다). 머리글은 제목 요소가 아니다 */
const NAV: { group: string | null; items: { id: Page; label: string; icon: IconName }[] }[] = [
  { group: null, items: [{ id: "home", label: "홈", icon: "home" }] },
  {
    group: "작성",
    items: [
      { id: "workspace", label: "워크스페이스", icon: "folder" },
      { id: "testcases", label: "TC", icon: "doc" },
      { id: "author", label: "플로우 만들기", icon: "sparkle" },
    ],
  },
  {
    group: "검증",
    items: [
      { id: "runs", label: "실행", icon: "play" },
      { id: "results", label: "결과", icon: "chart" },
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
      { id: "setup", label: "설정 마법사", icon: "wand" },
      { id: "settings", label: "설정", icon: "gear" },
    ],
  },
];

export function App() {
  const [page, setPage] = useState<Page | null>(null);
  const [resultsRunId, setResultsRunId] = useState<string | null>(null);

  // 마법사를 끝내지 않았으면 마법사부터 연다.
  useEffect(() => {
    window.qa.settings
      .get()
      .then((state) => setPage(state.settings.setup.completedAt ? "home" : "setup"))
      .catch(() => setPage("home"));
  }, []);

  function go(next: Page) {
    setResultsRunId(null);
    setPage(next);
  }

  return (
    <div className="window">
      <Toolbar page={page} onNavigate={go} />
      <div className="layout">
        <nav className="sidebar" aria-label="주 메뉴">
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
                </button>
              ))}
            </div>
          ))}
        </nav>
        <main className={page === "results" ? "content wide" : "content"}>
          <UpdateBanner />
          {page === "home" ? <HomePage /> : null}
          {page === "workspace" ? <WorkspacePage /> : null}
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
          {page === "results" ? <ResultsPage key={resultsRunId ?? "none"} initialRunId={resultsRunId} /> : null}
          {page === "devices" ? <DevicesPage /> : null}
          {page === "builds" ? <BuildsPage /> : null}
          {page === "settings" ? <SettingsPage /> : null}
          {page === "setup" ? <SetupWizard onFinished={() => setPage("home")} onClose={() => setPage("home")} /> : null}
        </main>
      </div>
    </div>
  );
}
