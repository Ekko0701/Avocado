import type { IpcHandlers } from "@qa/shared";
import type { WorkspaceService } from "./workspace-service";

type WorkspaceChannel =
  | "workspace:status"
  | "workspace:connect"
  | "workspace:sync"
  | "workspace:testcases"
  | "workspace:accounts"
  | "workspace:readTestcase"
  | "workspace:saveTestcase"
  | "workspace:requestReview"
  | "workspace:branches"
  | "workspace:checkout"
  | "workspace:readApp"
  | "workspace:saveApp"
  | "workspace:history"
  | "workspace:myPulls";

export function createWorkspaceHandlers(ws: WorkspaceService): Pick<IpcHandlers, WorkspaceChannel> {
  return {
    "workspace:status": () => ws.status(),
    "workspace:connect": () => ws.connect(),
    "workspace:sync": () => ws.sync(),
    "workspace:testcases": () => ws.testcases(),
    "workspace:accounts": () => ws.accounts(),
    "workspace:readTestcase": ({ app, id }) => ws.readTestcase(app, id),
    "workspace:saveTestcase": (input) => ws.saveTestcase(input),
    "workspace:requestReview": (input) => ws.requestReview(input),
    "workspace:branches": () => ws.branches(),
    "workspace:checkout": ({ branch }) => ws.checkout(branch),
    "workspace:readApp": ({ app }) => ws.readApp(app),
    "workspace:saveApp": (input) => ws.saveApp(input),
    "workspace:history": ({ app, id }) => ws.history(app, id),
    "workspace:myPulls": () => ws.myPullRequests(),
  };
}
