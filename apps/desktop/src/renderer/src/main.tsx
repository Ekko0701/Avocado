import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WorkspaceStatusProvider } from "./lib/workspace-status";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root 가 없다");
createRoot(root).render(
  <StrictMode>
    <WorkspaceStatusProvider>
      <App />
    </WorkspaceStatusProvider>
  </StrictMode>,
);
