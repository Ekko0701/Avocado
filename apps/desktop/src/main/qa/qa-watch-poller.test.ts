import type { QaJob, QaWatchApp, QaWatchSettings } from "@qa/shared";
import { describe, expect, it } from "vitest";
import { QaWatchPoller, wakePrompt } from "./qa-watch-poller";

const app: QaWatchApp = { id: "a1", project: "앱-QA", tag: "자동수정", scope: "assigned_to_me", repoPath: "/repo", enabled: true };
const settings: QaWatchSettings = { enabled: true, intervalMinutes: 1, days: [1], startHour: 9, endHour: 18, autoMr: true, autoComment: false, apps: [app, { ...app, id: "a2", enabled: false }] };

function setup(over: { claim?: () => { reason: string } | { settings: QaWatchSettings }; tickets?: string[]; handled?: string[]; wake?: () => Promise<void> } = {}) {
  const woken: string[] = [];
  const log: string[] = [];
  let asked = 0;
  const poller = new QaWatchPoller({
    watch: { claim: over.claim ?? (() => ({ settings })) },
    jobs: { list: () => (over.handled ?? []).map((ticket) => ({ ticket }) as QaJob) },
    dooray: {
      openTickets: () => {
        asked += 1;
        return Promise.resolve((over.tickets ?? []).map((ticket) => ({ ticket, postId: `id-${ticket}` })));
      },
    },
    wake: (prompt) => {
      woken.push(prompt);
      return over.wake?.() ?? Promise.resolve();
    },
    log: (line) => log.push(line),
  });
  return { poller, woken, log, asked: () => asked };
}

describe("QaWatchPoller", () => {
  it("확인할 때가 아니면 조회하지 않는다", async () => {
    const t = setup({ claim: () => ({ reason: "자동 처리가 꺼져 있다." }), tickets: ["앱-QA/1"] });
    await t.poller.tick();
    expect(t.asked()).toBe(0);
    expect(t.woken).toEqual([]);
  });

  it("새 티켓이 없으면 켜진 항목만 조회하고 Claude Code 를 깨우지 않는다", async () => {
    const t = setup({ tickets: ["앱-QA/1"], handled: ["앱-QA/1"] });
    await t.poller.tick();
    expect(t.asked()).toBe(1);
    expect(t.woken).toEqual([]);
  });

  it("아직 다루지 않은 티켓 중 먼저 등록된 한 건으로 깨우고, 같은 티켓으로 다시 깨우지 않는다", async () => {
    const t = setup({ tickets: ["앱-QA/1", "앱-QA/2", "앱-QA/3"], handled: ["앱-QA/1"] });
    await t.poller.tick();
    expect(t.woken).toHaveLength(1);
    expect(t.woken[0]).toContain("티켓: 앱-QA/2 (업무 ID id-앱-QA/2)");
    await t.poller.tick();
    expect(t.woken).toHaveLength(2);
    expect(t.woken[1]).toContain("티켓: 앱-QA/3");
    await t.poller.tick();
    expect(t.woken).toHaveLength(2);
  });

  it("깨운 실행이 끝나기 전에는 다시 확인하지 않는다", async () => {
    let finish = () => {};
    const t = setup({ tickets: ["앱-QA/1", "앱-QA/2"], wake: () => new Promise<void>((resolve) => (finish = resolve)) });
    const first = t.poller.tick();
    await Promise.resolve();
    await Promise.resolve();
    await t.poller.tick();
    expect(t.asked()).toBe(1);
    finish();
    await first;
  });

  it("조회가 실패하면 적어 두고 다음 확인을 막지 않는다", async () => {
    const t = setup();
    (t.poller as unknown as { options: { dooray: { openTickets: () => Promise<never> } } }).options.dooray.openTickets = () => Promise.reject(new Error("두레이 토큰을 먼저 저장한다"));
    await t.poller.tick();
    expect(t.log).toEqual(["확인에 실패했다: 두레이 토큰을 먼저 저장한다"]);
    await t.poller.tick();
    expect(t.log).toHaveLength(2);
  });
});

describe("wakePrompt", () => {
  it("티켓과 저장소 폴더, 사람 확인 없이 해도 되는 일을 적는다", () => {
    const prompt = wakePrompt({ ticket: "앱-QA/7", postId: "123" }, app, settings);
    expect(prompt.startsWith("/qa-fix ")).toBe(true);
    expect(prompt).toContain("저장소 폴더: /repo");
    expect(prompt).toContain("사람 확인 없이 MR 올리기: 해도 된다");
    expect(prompt).toContain("사람 확인 없이 티켓 댓글 달기: 하지 않는다");
  });
});
