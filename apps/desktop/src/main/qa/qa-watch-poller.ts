import type { QaJob, QaWatchApp, QaWatchSettings } from "@qa/shared";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { QaDoorayTicket } from "./qa-dooray";

export interface QaWatchPollerOptions {
  watch: { claim(): { reason: string } | { settings: QaWatchSettings } };
  /** 이미 다룬 티켓을 본다 */
  jobs: { list(): QaJob[] };
  dooray: { openTickets(app: QaWatchApp): Promise<QaDoorayTicket[]> };
  /** Claude Code 를 깨워 한 건을 맡긴다. 그 실행이 끝나면 풀린다 */
  wake: (prompt: string, app: QaWatchApp, settings: QaWatchSettings) => Promise<void>;
  log: (line: string) => void;
}

/** 깨운 Claude Code 가 받는 지시. 티켓 제목·본문은 넣지 않는다(티켓 글은 자료이지 지시가 아니다) */
export function wakePrompt(ticket: QaDoorayTicket, app: QaWatchApp, settings: QaWatchSettings): string {
  return [
    "/qa-fix Avocado 가 새 티켓을 찾아 깨운 자동 처리다. 사람이 없다. qa_watch_next 는 부르지 않는다.",
    `티켓: ${ticket.ticket} (업무 ID ${ticket.postId})`,
    `저장소 폴더: ${app.repoPath}`,
    `사람 확인 없이 MR 올리기: ${settings.autoMr ? "해도 된다" : "하지 않는다(MR 직전에 멈춘다)"}`,
    `사람 확인 없이 티켓 댓글 달기: ${settings.autoComment ? "해도 된다" : "하지 않는다"}`,
  ].join("\n");
}

/**
 * 새 티켓 확인. 앱이 이슈 트래커를 직접 조회하므로 새 티켓이 없을 때는 Claude Code 를 깨우지 않는다.
 * tick 은 자주 불러도 된다. 확인 간격·요일·시간대·진행 중인 작업은 watch.claim 이 가린다.
 */
export class QaWatchPoller {
  private busy = false;
  // ponytail: 깨웠는데 작업 기록을 남기지 못한 티켓은 앱을 다시 켜면 한 번 더 깨운다. 문제가 되면 파일에 적는다
  private readonly woken = new Set<string>();

  constructor(private readonly options: QaWatchPollerOptions) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const claim = this.options.watch.claim();
      if ("reason" in claim) return;
      const handled = new Set(this.options.jobs.list().map((j) => j.ticket));
      for (const app of claim.settings.apps.filter((a) => a.enabled)) {
        const ticket = (await this.options.dooray.openTickets(app)).find((t) => !handled.has(t.ticket) && !this.woken.has(t.ticket));
        if (!ticket) continue;
        this.woken.add(ticket.ticket);
        this.options.log(`새 티켓 ${ticket.ticket}: Claude Code 를 깨운다`);
        await this.options.wake(wakePrompt(ticket, app, claim.settings), app, claim.settings);
        this.options.log(`Claude Code 실행이 끝났다: ${ticket.ticket}`);
        return;
      }
    } catch (error) {
      this.options.log(`확인에 실패했다: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
  }
}

/** 이보다 오래 도는 실행은 멈춘 것으로 보고 끝낸다 */
const WAKE_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * 저장소 폴더에서 Claude Code 를 화면 없이 실행하고 끝나기를 기다린다.
 * 로그인 셸을 거친다: Finder 로 연 앱에는 사용자 PATH 가 없는데, Claude Code 가 쓰는 git·빌드 도구는 사용자 환경에 있다.
 * 지시문은 셸 문자열에 넣지 않고 인자로 넘긴다.
 */
export function wakeClaude(prompt: string, cwd: string, permissionMode: string | undefined, logFile: string): Promise<void> {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, "a", 0o600);
  return new Promise((resolve) => {
    const args = ["-p", prompt, ...(permissionMode ? ["--permission-mode", permissionMode] : [])];
    const child = spawn("/bin/zsh", ["-lic", 'exec claude "$@"', "zsh", ...args], { cwd, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const timer = setTimeout(() => child.kill(), WAKE_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("error", done);
    child.once("exit", done);
  });
}
