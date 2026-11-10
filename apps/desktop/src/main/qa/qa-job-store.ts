import { QaJobSchema, type QaJob } from "@qa/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const FileSchema = z.strictObject({ jobs: z.array(QaJobSchema) });
/** 오래된 작업은 버린다. 화면은 최근 것만 본다 */
const MAX_JOBS = 200;

/**
 * QA 수정 작업 기록. 실행 기록 DB 가 아니라 JSON 파일 하나에 둔다.
 * 사이드 브랜치 기능이라 DB 스키마 버전을 올리면 main 브랜치의 앱이 같은 데이터 폴더를 열지 못하게 되기 때문이다.
 */
export class QaJobStore {
  private jobs: QaJob[];

  constructor(private readonly file: string) {
    this.jobs = this.load();
  }

  private load(): QaJob[] {
    if (!existsSync(this.file)) return [];
    // 파일이 깨졌으면 조용히 비우지 않고 알린다
    return FileSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))).jobs;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ jobs: this.jobs }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** 최근에 바뀐 작업부터 */
  list(): QaJob[] {
    return [...this.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): QaJob | null {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  put(job: QaJob): QaJob {
    const parsed = QaJobSchema.parse(job);
    const at = this.jobs.findIndex((j) => j.id === parsed.id);
    if (at >= 0) this.jobs[at] = parsed;
    else this.jobs.push(parsed);
    if (this.jobs.length > MAX_JOBS) this.jobs = this.list().slice(0, MAX_JOBS);
    this.save();
    return parsed;
  }
}
