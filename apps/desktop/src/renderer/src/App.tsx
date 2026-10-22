import { useEffect, useState } from "react";
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

const NAV: { id: Page; label: string }[] = [
  { id: "home", label: "홈" },
  { id: "workspace", label: "워크스페이스" },
  { id: "testcases", label: "TC" },
  { id: "author", label: "플로우 만들기" },
  { id: "runs", label: "실행" },
  { id: "results", label: "결과" },
  { id: "devices", label: "기기" },
  { id: "builds", label: "빌드" },
  { id: "setup", label: "설정 마법사" },
  { id: "settings", label: "설정" },
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

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="주 메뉴">
        <div className="brand">Avocado</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={page === item.id ? "nav-item active" : "nav-item"}
            aria-current={page === item.id ? "page" : undefined}
            onClick={() => {
              setResultsRunId(null);
              setPage(item.id);
            }}
          >
            {item.label}
          </button>
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
  );
}
