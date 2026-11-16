import type { IpcHandlers } from "@qa/shared";
import type { WorkspaceService } from "./workspace-service";

type WorkspaceChannel =
  | "workspace:status"
  | "workspace:setSource"
  | "workspace:reveal"
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
  | "workspace:subflows"
  | "workspace:saveSubflow"
  | "workspace:migrateLayout"
  | "workspace:history"
  | "workspace:myPulls"
  | "workspace:exportInfo"
  | "workspace:export"
  | "workspace:importPick"
  | "workspace:importApply"
  | "workspace:importCancel";

export function createWorkspaceHandlers(ws: WorkspaceService): Pick<IpcHandlers, WorkspaceChannel> {
  return {
    "workspace:status": () => ws.status(),
    "workspace:setSource": ({ source }) => ws.setSource(source),
    "workspace:reveal": () => ws.reveal(),
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
    "workspace:subflows": ({ app }) => ws.subflows(app),
    "workspace:saveSubflow": (input) => ws.saveSubflow(input),
    "workspace:migrateLayout": () => ws.migrateLayout(),
    "workspace:history": ({ app, id }) => ws.history(app, id),
    "workspace:myPulls": () => ws.myPullRequests(),
    "workspace:exportInfo": () => ws.exportInfo(),
    "workspace:export": () => ws.exportZip(),
    "workspace:importPick": ({ from }) => ws.importPick(from),
    "workspace:importApply": (input) => ws.importApply(input),
    "workspace:importCancel": ({ importId }) => ws.importCancel(importId),
  };
}
