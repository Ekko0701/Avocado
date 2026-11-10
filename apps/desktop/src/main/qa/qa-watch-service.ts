import { errorToMcpResult, toMcpResult, type McpToolDefinition, type McpToolResult } from "@qa/agent";
import { DEFAULT_QA_WATCH_SETTINGS, QaWatchSettingsSchema, QaWatchStateSchema, type QaJob, type QaWatchSettings, type QaWatchState } from "@qa/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";

export class QaWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaWatchError";
  }
}

export interface QaWatchServiceOptions {
  /** userData/qa-jobs/watch.json. DB·설정 파일이 아니라 따로 둔다(main 브랜치의 앱이 같은 데이터 폴더를 열 수 있게) */
  file: string;
  /** 이미 다룬 티켓과 진행 중인 작업을 본다 */
  jobs: { list(): QaJob[] };
  now?: () => Date;
}

const NextSchema = z.strictObject({
  force: z.boolean().optional().describe("true 면 간격·요일·시간대를 보지 않고 바로 확인한다(사람이 직접 시킬 때만)"),
});

const TOOLS: McpToolDefinition[] = [
  {
    name: "qa_watch_next",
    description:
      "QA 티켓 자동 처리를 지금 해도 되는지 Avocado 에 묻는다. 꺼져 있거나, 확인할 때가 아니거나, 진행 중인 작업이 있으면 그 이유를 받고 아무것도 하지 않는다. 해도 되면 어느 프로젝트의 어떤 태그를 어느 저장소 폴더에서 처리할지와, 사람 확인 없이 MR·댓글을 올려도 되는지, 이미 다룬 티켓 목록을 받는다.",
    inputSchema: (() => {
      const out: Record<string, unknown> = { ...z.toJSONSchema(NextSchema) };
      delete out["$schema"];
      return { ...out, type: "object" as const };
    })(),
  },
];

/** 진행 중으로 남은 작업이 이 시간 넘게 그대로면 멈춘 것으로 보고 새 확인을 막지 않는다 */
const STALE_RUNNING_MS = 6 * 60 * 60_000;
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * QA 티켓 자동 처리 설정과 "지금 확인할 때인가" 판단.
 * 간격·요일·시간대는 여기서 정한다. Claude Code 쪽 예약 작업은 자주 깨어나 qa_watch_next 를 부르기만 하면 된다.
 */
export class QaWatchService {
  private readonly now: () => Date;
  private state: QaWatchState;

  constructor(private readonly options: QaWatchServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  static mcpTools(): McpToolDefinition[] {
    return TOOLS;
  }

  private load(): QaWatchState {
    if (!existsSync(this.options.file)) return { settings: DEFAULT_QA_WATCH_SETTINGS, lastCheckedAt: null };
    // 파일이 깨졌으면 조용히 기본값으로 바꾸지 않고 알린다
    return QaWatchStateSchema.parse(JSON.parse(readFileSync(this.options.file, "utf8")));
  }

  private write(state: QaWatchState): void {
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.options.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.options.file);
    this.state = state;
  }

  get(): QaWatchState {
    return this.state;
  }

  save(input: QaWatchSettings): QaWatchState {
    const settings = QaWatchSettingsSchema.parse(input);
    for (const app of settings.apps) {
      if (!isAbsolute(app.repoPath) || !existsSync(app.repoPath) || !statSync(app.repoPath).isDirectory()) {
        throw new QaWatchError(`저장소 폴더가 없다: ${app.repoPath}`);
      }
    }
    if (new Set(settings.apps.map((a) => a.id)).size !== settings.apps.length) throw new QaWatchError("같은 항목이 두 번 들어 있다");
    this.write({ settings, lastCheckedAt: this.state.lastCheckedAt });
    return this.state;
  }

  mcpCall(name: string, args: unknown): McpToolResult {
    try {
      if (name === "qa_watch_next") return toMcpResult(this.next(NextSchema.parse(args ?? {})));
      throw new QaWatchError(`모르는 도구다: ${name}`);
    } catch (error) {
      if (error instanceof z.ZodError) return errorToMcpResult(error, (t) => t);
      return toMcpResult(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** 지금 확인하면 안 되는 이유. 해도 되면 null */
  private blocked(now: Date, force: boolean): string | null {
    const { settings, lastCheckedAt } = this.state;
    if (!settings.enabled) return "자동 처리가 꺼져 있다.";
    const apps = settings.apps.filter((a) => a.enabled);
    if (apps.length === 0) return "켜져 있는 감시 항목이 없다.";
    const running = this.options.jobs.list().find((j) => j.status === "running" && now.getTime() - Date.parse(j.updatedAt) < STALE_RUNNING_MS);
    if (running) return `진행 중인 작업이 있다: ${running.ticket} (${running.stage} 단계). 한 번에 한 건만 처리한다.`;
    if (force) return null;
    if (!settings.days.includes(now.getDay())) return `오늘(${DAY_NAMES[now.getDay()]}요일)은 확인하는 요일이 아니다.`;
    if (now.getHours() < settings.startHour || now.getHours() >= settings.endHour) return `지금은 확인 시간대(${settings.startHour}시~${settings.endHour}시)가 아니다.`;
    if (lastCheckedAt) {
      const next = Date.parse(lastCheckedAt) + settings.intervalMinutes * 60_000;
      if (now.getTime() < next) return `아직 확인 간격(${settings.intervalMinutes}분)이 지나지 않았다. 다음 확인은 ${Math.ceil((next - now.getTime()) / 60_000)}분 뒤다.`;
    }
    return null;
  }

  private next(input: z.infer<typeof NextSchema>): string {
    const now = this.now();
    const reason = this.blocked(now, input.force === true);
    if (reason) return `${reason} 지금은 아무것도 하지 않는다.`;
    const { settings } = this.state;
    this.write({ settings, lastCheckedAt: now.toISOString() });
    const handled = [...new Set(this.options.jobs.list().map((j) => j.ticket))];
    return [
      "지금 새 티켓을 확인한다. 아래 항목을 위에서부터 보고, 아직 다루지 않은 티켓 한 건만 처리한다.",
      "",
      "감시 항목:",
      ...settings.apps
        .filter((a) => a.enabled)
        .map((a) => `- 앱 ${a.app} · 프로젝트 "${a.project}" · 태그 "${a.tag}" · 대상 ${a.scope === "assigned_to_me" ? "나에게 배정된 것만" : "태그가 붙은 것 전부"} · 저장소 폴더 ${a.repoPath}`),
      "",
      `사람 확인 없이 MR 올리기: ${settings.autoMr ? "해도 된다" : "하지 않는다(MR 직전에 멈추고 사람 확인을 기다린다)"}`,
      `사람 확인 없이 티켓 댓글 달기: ${settings.autoComment ? "해도 된다" : "하지 않는다"}`,
      "",
      `이미 다룬 티켓(다시 처리하지 않는다): ${handled.length > 0 ? handled.join(", ") : "없음"}`,
    ].join("\n");
  }
}
