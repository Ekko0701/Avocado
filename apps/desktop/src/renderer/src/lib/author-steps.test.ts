import { AuthorJobSchema, type AuthorJob } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { authorSteps, failedReplayRun, stoppedPhase, stoppedTitle } from "./author-steps";

const job = (over: Record<string, unknown> = {}, summary: Record<string, unknown> = {}): AuthorJob =>
  AuthorJobSchema.parse({
    job: { id: "job-1", type: "author", status: "running", model: "claude-app", inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, error: null, createdAt: "2026-11-10T01:00:00.000Z", finishedAt: null, ...summary },
    app: "demo",
    tcId: "TC-0101",
    target: "android",
    phase: "preparing",
    driver: "claude-app",
    claudeRequest: null,
    claudeClient: null,
    attempt: 1,
    step: 0,
    totalSteps: 7,
    log: [],
    submission: null,
    lint: [],
    replays: [],
    result: null,
    ...over,
  });
const states = (j: AuthorJob | null, driver: AuthorJob["driver"] = "claude-app") => authorSteps(j, driver).map((s) => `${s.label}:${s.state}:${s.sub}`);

describe("플로우 만들기 단계 표시줄", () => {
  it("시작 전에는 모두 대기이고, API 키 방식에는 Claude 에 요청 단계가 없다", () => {
    expect(authorSteps(null, "claude-app").map((s) => [s.label, s.state])).toEqual([
      ["준비", "pending"],
      ["Claude 에 요청", "pending"],
      ["기기 탐색", "pending"],
      ["규약 검사", "pending"],
      ["두 번 재생", "pending"],
      ["저장", "pending"],
    ]);
    expect(authorSteps(null, "api").map((s) => s.label)).toEqual(["준비", "기기 탐색", "규약 검사", "두 번 재생", "저장"]);
  });

  it("진행 중: 앞 단계는 끝, 지금 단계는 진행(Claude 대기는 내 차례), 뒤는 대기", () => {
    expect(states(job({ phase: "waiting_claude" }))).toEqual([
      "준비:done:끝",
      "Claude 에 요청:mine:내 차례",
      "기기 탐색:pending:테스트 케이스 따라가기",
      "규약 검사:pending:플로우 규약",
      "두 번 재생:pending:같은 기기에서",
      "저장:pending:작업 브랜치 커밋",
    ]);
    expect(states(job({ phase: "exploring", step: 3 })).slice(1, 3)).toEqual(["Claude 에 요청:done:끝", "기기 탐색:active:스텝 3/7"]);
    expect(states(job({ phase: "replaying", replays: [{ runId: "r1", status: "passed", flaky: false }], lint: [{ level: "warning", rule: "x", message: "m", line: null }] })).slice(2, 5)).toEqual([
      "기기 탐색:done:스텝 7/7",
      "규약 검사:done:경고 1개",
      "두 번 재생:active:2번째 재생",
    ]);
  });

  it("성공하면 모두 끝이고 저장 단계에 커밋이 보인다", () => {
    const done = job({ phase: "done", result: { flowPath: "f.yaml", branch: "qa/x", commit: "a1b2c3d4e5", goldenRunId: "r2" } }, { status: "succeeded" });
    expect(states(done).map((s) => s.split(":")[1])).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(states(done).at(-1)).toBe("저장:done:a1b2c3d");
    expect(stoppedPhase(done)).toBeNull();
  });

  it("통과하지 못하면 멈춘 단계가 실패이고 그 뒤는 하지 않음", () => {
    const failed = job(
      { phase: "done", stoppedAt: "replaying", replays: [{ runId: "r1", status: "passed", flaky: false }, { runId: "r2", status: "failed", flaky: false }] },
      { status: "failed", error: "재생 2 실패" },
    );
    expect(states(failed).slice(3)).toEqual(["규약 검사:done:오류 없음", "두 번 재생:failed:2번 실패", "저장:pending:하지 않음"]);
    expect(stoppedTitle(failed)).toBe("재생에서 실패해 저장하지 않았습니다");
    expect(failedReplayRun(failed)).toBe("r2");

    const canceled = job({ phase: "done", stoppedAt: "waiting_claude" }, { status: "canceled" });
    expect(states(canceled).slice(0, 3)).toEqual(["준비:done:끝", "Claude 에 요청:failed:취소", "기기 탐색:pending:하지 않음"]);
    expect(stoppedTitle(canceled)).toBe("Claude 에 요청 단계에서 취소했습니다");
    expect(failedReplayRun(canceled)).toBeNull();
  });

  it("멈춘 단계를 남기지 않은 예전 기록은 남은 결과로 짐작하고, 모르면 어느 단계도 끝났다고 하지 않는다", () => {
    const lint = job({ phase: "done", lint: [{ level: "error", rule: "x", message: "m", line: 3 }] }, { status: "failed" });
    expect(stoppedPhase(lint)).toBe("checking");
    expect(states(lint)[3]).toBe("규약 검사:failed:오류 1개");
    const replay = job({ phase: "done", replays: [{ runId: "r1", status: "failed", flaky: false }] }, { status: "failed" });
    expect(stoppedPhase(replay)).toBe("replaying");
    const unknown = job({ phase: "done" }, { status: "failed" });
    expect(stoppedPhase(unknown)).toBeNull();
    expect(states(unknown).every((s) => s.includes(":pending:"))).toBe(true);
    expect(stoppedTitle(unknown)).toBe("플로우를 만들지 못했습니다");
  });
});
