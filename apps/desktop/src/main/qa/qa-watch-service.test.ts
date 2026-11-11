import type { QaJob, QaWatchSettings } from "@qa/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaWatchService } from "./qa-watch-service";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 2026-11-10 은 화요일. 이 Mac 의 시각으로 만든다 */
const at = (hour: number, minute = 0, day = 10) => new Date(2026, 10, day, hour, minute, 0);

const job = (over: Partial<QaJob>): QaJob => ({
  id: "job-1",
  ticket: "앱-QA/567",
  title: "제목",
  url: null,
  stage: "mr",
  status: "succeeded",
  branch: null,
  mrUrl: null,
  verification: "verified",
  verificationNote: null,
  artifacts: [],
  events: [],
  runs: [],
  createdAt: at(9).toISOString(),
  updatedAt: at(9).toISOString(),
  ...over,
});

function setup(opts: { now?: Date; jobs?: QaJob[] } = {}) {
  let now = opts.now ?? at(10);
  const service = new QaWatchService({ file: join(dir, "watch.json"), jobs: { list: () => opts.jobs ?? [] }, now: () => now });
  const settings = (over: Partial<QaWatchSettings> = {}): QaWatchSettings => ({
    enabled: true,
    intervalMinutes: 30,
    days: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 18,
    autoMr: false,
    autoComment: false,
    apps: [{ id: "a1", project: "앱-QA", tag: "자동수정", scope: "assigned_to_me", repoPath: dir, enabled: true }],
    ...over,
  });
  const next = (args: unknown = {}) => {
    const r = service.mcpCall("qa_watch_next", args);
    const first = r.content[0];
    return first?.type === "text" ? first.text : "";
  };
  return { service, settings, next, setNow: (d: Date) => (now = d) };
}

describe("QA 티켓 자동 처리 설정", () => {
  it("처음에는 꺼져 있고 아무것도 하지 않는다", () => {
    const { service, next } = setup();
    expect(service.get().settings.enabled).toBe(false);
    expect(next()).toContain("꺼져 있다");
  });

  it("확인할 때가 되면 감시 항목, 사람 확인 없이 해도 되는 일, 이미 다룬 티켓을 알려 준다", () => {
    const { service, settings, next } = setup({ jobs: [job({})] });
    service.save(settings({ autoMr: true }));
    const text = next();
    expect(text).toContain('프로젝트 "앱-QA"');
    expect(text).toContain('태그 "자동수정"');
    expect(text).toContain("나에게 배정된 것만");
    expect(text).toContain(dir);
    expect(text).toContain("사람 확인 없이 MR 올리기: 해도 된다");
    expect(text).toContain("사람 확인 없이 티켓 댓글 달기: 하지 않는다");
    expect(text).toContain("앱-QA/567");
  });

  it("한 번 확인을 넘겨주면 간격이 지날 때까지 다시 넘겨주지 않는다", () => {
    const { service, settings, next, setNow } = setup();
    service.save(settings());
    expect(next()).toContain("지금 새 티켓을 확인한다");
    setNow(at(10, 20));
    expect(next()).toContain("다음 확인은 10분 뒤");
    setNow(at(10, 30));
    expect(next()).toContain("지금 새 티켓을 확인한다");
  });

  it("확인하는 요일과 시간대가 아니면 넘겨주지 않는다", () => {
    const { service, settings, next, setNow } = setup();
    service.save(settings());
    setNow(at(8, 59));
    expect(next()).toContain("확인 시간대(9시~18시)가 아니다");
    setNow(at(18));
    expect(next()).toContain("확인 시간대");
    setNow(at(10, 0, 14)); // 토요일
    expect(next()).toContain("토요일");
  });

  it("진행 중인 작업이 있으면 새로 시작하지 않는다(6시간 넘게 그대로면 멈춘 것으로 본다)", () => {
    const running = job({ ticket: "앱-QA/600", status: "running", stage: "build", updatedAt: at(9, 30).toISOString() });
    const a = setup({ jobs: [running] });
    a.service.save(a.settings());
    expect(a.next()).toContain("진행 중인 작업이 있다: 앱-QA/600");
    expect(a.next({ force: true })).toContain("진행 중인 작업이 있다");
    a.setNow(at(16));
    expect(a.next()).toContain("지금 새 티켓을 확인한다");
  });

  it("force 는 간격·요일·시간대만 건너뛰고, 꺼져 있으면 여전히 하지 않는다", () => {
    const { service, settings, next, setNow } = setup();
    service.save(settings());
    setNow(at(23));
    expect(next({ force: true })).toContain("지금 새 티켓을 확인한다");
    service.save(settings({ enabled: false }));
    expect(next({ force: true })).toContain("꺼져 있다");
  });

  it("꺼 둔 항목은 넘겨주지 않고, 켜진 항목이 없으면 하지 않는다", () => {
    const { service, settings, next } = setup();
    const base = settings().apps[0];
    if (!base) throw new Error("fixture");
    service.save(settings({ apps: [{ ...base, enabled: false }, { ...base, id: "a2", project: "다른-QA" }] }));
    const text = next();
    expect(text).toContain("다른-QA");
    expect(text).not.toContain('"앱-QA"');
    service.save(settings({ apps: [{ ...base, enabled: false }] }));
    expect(next({ force: true })).toContain("켜져 있는 감시 항목이 없다");
  });

  it("없는 저장소 폴더나 뒤집힌 시간대는 저장하지 않는다", () => {
    const { service, settings } = setup();
    const base = settings().apps[0];
    if (!base) throw new Error("fixture");
    expect(() => service.save(settings({ apps: [{ ...base, repoPath: join(dir, "없는폴더") }] }))).toThrow(/저장소 폴더가 없다/);
    expect(() => service.save(settings({ apps: [{ ...base, repoPath: "relative/path" }] }))).toThrow(/저장소 폴더가 없다/);
    expect(() => service.save(settings({ startHour: 18, endHour: 9 }))).toThrow();
    expect(service.get().settings.enabled).toBe(false);
  });

  it("설정은 파일에 남고, 파일이 깨졌으면 조용히 기본값으로 바꾸지 않는다", () => {
    const { service, settings } = setup();
    service.save(settings());
    expect(new QaWatchService({ file: join(dir, "watch.json"), jobs: { list: () => [] } }).get().settings.apps[0]?.tag).toBe("자동수정");
    writeFileSync(join(dir, "watch.json"), "{ 깨진 파일");
    expect(() => new QaWatchService({ file: join(dir, "watch.json"), jobs: { list: () => [] } })).toThrow();
  });
});
