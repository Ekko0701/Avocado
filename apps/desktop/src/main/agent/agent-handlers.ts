import type { IpcHandlers, Settings } from "@qa/shared";
import type { AgentJobStore } from "./agent-job-store";
import type { AuthorService } from "./author-service";
import type { JudgeService } from "./judge-service";

export function createAgentHandlers(
  jobs: AgentJobStore,
  author: AuthorService,
  judge: JudgeService,
  settings: () => Settings,
): Pick<
  IpcHandlers,
  | "agent:usage"
  | "agent:startAuthor"
  | "agent:authorStatus"
  | "agent:currentAuthor"
  | "agent:cancel"
  | "agent:judge"
  | "agent:judgements"
  | "agent:startClaudeJudge"
  | "agent:claudeJudgeStatus"
  | "agent:cancelClaudeJudge"
> {
  return {
    "agent:usage": () => jobs.usage(settings().agent.monthlyBudgetUsd),
    "agent:startAuthor": (input) => author.start(input),
    "agent:authorStatus": ({ jobId }) => author.status(jobId),
    "agent:currentAuthor": () => author.current(),
    "agent:cancel": ({ jobId }) => author.cancel(jobId),
    "agent:judge": ({ runId, executionId }) => judge.judgeExecution(runId, executionId, { all: true }),
    "agent:judgements": ({ runId, executionId }) => judge.list(runId, executionId),
    "agent:startClaudeJudge": ({ runId, executionId }) => judge.startClaude(runId, executionId),
    "agent:claudeJudgeStatus": ({ jobId }) => judge.claudeStatus(jobId),
    "agent:cancelClaudeJudge": ({ jobId }) => judge.cancelClaude(jobId),
  };
}
