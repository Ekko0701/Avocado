import { redactExecutionDir, type JpegConverter } from "@qa/evidence";
import { GitHubProvider } from "@qa/remote";
import type { RunDetail } from "@qa/shared";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub } from "../../../../../packages/remote/src/testing/fake-github";
import { AppDatabase } from "../db/database";
import { UploadError, UploadService } from "./upload-service";

const FIXTURES = resolve(__dirname, "../../../../../packages/evidence/fixtures");
// packages/evidence/fixtures/README.md 의 가짜 값
const FAKE_SECRETS = ["qa-fixture-id-7f3a", 'fixture"Pw&2026'];
const TOKEN = "ghp_fake_token_for_upload_tests_000000";
const toJpeg: JpegConverter = async (png) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png.subarray(0, 16)]);

let dir: string;
let db: AppDatabase;
let fake: FakeGitHub;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qa-upload-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  db.db.prepare("INSERT INTO run (id, workspace, trigger, status, created_at) VALUES ('run-1', 'w', 'manual', 'failed', '2026-10-22T00:00:00.000Z')").run();
  db.db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status, evidence_dir) VALUES ('exec-1', 'run-1', 'TC-0009', 'ios', 'x', 'failed', 'run-1/exec-1')").run();
  fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-evidence-2026": { push: true } } });
  redactExecutionDir(join(FIXTURES, "ios-fail"), join(dir, "redacted"), { secrets: FAKE_SECRETS });
});
afterEach(async () => {
  db.close();
  await fake.close();
});

function run(status: RunDetail["status"]): RunDetail {
  return {
    id: "run-1",
    status,
    app: "settings",
    flowName: "fixture iOS 설정 검색 실패",
    flowPath: "x",
    tcId: "TC-0009",
    target: "ios",
    deviceId: "SIM-1",
    deviceName: "QA Tool iPhone 17 / iOS 27.0",
    buildId: null,
    buildLabel: null,
    attempts: 1,
    flaky: false,
    failureMessage: "실패",
    kept: false,
    evidenceRemoved: false,
    createdAt: "2026-10-22T00:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-10-22T00:01:00.000Z",
    executions: [{ id: "exec-1", attempt: 1, status: "failed", durationMs: 1, failureClass: "unknown", failure: null, hostLoad: null, startedAt: null, finishedAt: null, warnings: [], steps: [] }],
  };
}

function service(opts: { approved?: boolean; status?: RunDetail["status"]; secrets?: string[]; jpeg?: JpegConverter; maxImages?: number } = {}) {
  const redacted = join(dir, "redacted");
  return new UploadService({
    db,
    runs: { get: () => run(opts.status ?? "failed") },
    evidence: { redactedDir: () => redacted },
    remote: new GitHubProvider({ token: () => TOKEN, apiUrl: fake.url, webUrl: "https://github.com" }),
    uploadApproved: () => opts.approved ?? true,
    github: () => ({ owner: "acme", workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-", appRepo: "qa-tool" }),
    secrets: () => opts.secrets ?? [...FAKE_SECRETS, TOKEN],
    toJpeg: opts.jpeg ?? toJpeg,
    generator: "qa-tool test",
    maxImages: opts.maxImages,
    now: () => new Date(2026, 9, 22, 10, 0),
    newId: () => "bundle-1",
  });
}

describe("증적 업로드 (PLAN 9.3·9.4)", () => {
  it("미리보기 → 개인정보 확인 → 한 커밋으로 올리고 색인에 한 줄, report.md 주소를 돌려준다", async () => {
    const s = service();
    const preview = await s.prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false });
    expect(preview).toMatchObject({ bundleId: "bundle-1", repo: "acme/qa-evidence-2026", root: "runs/2026/10/22/run-1/exec-1", blocked: false, residue: [] });
    expect(preview.files.map((f) => f.path)).toEqual(expect.arrayContaining(["run.json", "report.md", "logs/maestro-excerpt.txt"]));
    expect(preview.thumbnails[0]?.dataUrl).toMatch(/^data:image\/jpeg;base64,/);

    const record = await s.upload({ bundleId: "bundle-1", privacyConfirmed: true });
    expect(record.url).toBe(`https://github.com/acme/qa-evidence-2026/blob/${record.commitSha}/runs/2026/10/22/run-1/exec-1/report.md`);
    const files = fake.files();
    expect([...files.keys()].filter((p) => p.startsWith("runs/2026/10/22/run-1/exec-1/")).length).toBe(preview.files.length);
    const index = files.get("index/2026-10.jsonl")?.toString("utf8") ?? "";
    expect(index.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(index) as { tcId: string; result: string }).toMatchObject({ tcId: "TC-0009", result: "failed" });
    expect(fake.commitMessages().at(-1)).toBe("evidence: TC-0009 ios failed run-1");
    const uploaded = Buffer.concat([...files.values()]).toString("utf8");
    for (const secret of [...FAKE_SECRETS, TOKEN]) expect(uploaded).not.toContain(secret);
    expect(s.uploads("run-1", "exec-1")).toEqual([record]);
    // 같은 미리보기로 두 번 올리지 않고, 이미 올린 실행은 다시 묶지 않는다
    await expect(s.upload({ bundleId: "bundle-1", privacyConfirmed: true })).rejects.toThrow("미리보기가 없거나 만료");
    await expect(s.prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false })).rejects.toThrow("이미 올린 실행");
  });

  it("묶음에 비밀 값이 남으면 막고(미리보기에 경로·개수만), 올리지 않는다", async () => {
    // 텍스트는 묶음을 만들 때 다시 가리므로, 가리지 못하는 이미지 바이트에 값이 들어간 경우를 흉내 낸다(예: 메타데이터)
    const s = service({ jpeg: async () => Buffer.from(`JPEG comment ${FAKE_SECRETS[1]}`) });
    const preview = await s.prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false });
    expect(preview.blocked).toBe(true);
    expect(preview.bundleId).toBeNull();
    expect(preview.residue.length).toBeGreaterThan(0);
    expect(JSON.stringify(preview.residue)).not.toContain(FAKE_SECRETS[1]);
    await expect(s.upload({ bundleId: "bundle-1", privacyConfirmed: true })).rejects.toThrow(UploadError);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("정책 스위치(D11)가 꺼져 있거나 실행이 끝나지 않았으면 만들지도 않는다", async () => {
    await expect(service({ approved: false }).prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false })).rejects.toThrow("D11");
    await expect(service({ status: "running" }).prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false })).rejects.toThrow("끝나지 않은");
    await expect(service().prepare({ runId: "run-1", executionId: "nope", includePassScreens: false })).rejects.toThrow("실행을 찾지 못했다");
  });

  it("미리보기 뒤 계정 값이 늘면 올리기 직전 검사에서 막는다", async () => {
    const secrets = [...FAKE_SECRETS];
    const s = service({ secrets });
    await s.prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false });
    // report.md 에 들어간 흐름 이름 일부가 나중에 비밀 값으로 등록됐다고 치자
    secrets.push("fixture iOS 설정 검색 실패");
    await expect(s.upload({ bundleId: "bundle-1", privacyConfirmed: true })).rejects.toThrow("비밀 값이 남아");
    expect(fake.requests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("증적 저장소가 없으면 운영자에게 만들어 달라는 안내", async () => {
    await fake.close();
    fake = await startFakeGitHub({ token: TOKEN, repos: {} });
    const s = service();
    await s.prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false });
    await expect(s.upload({ bundleId: "bundle-1", privacyConfirmed: true })).rejects.toThrow("운영자에게 만들어 달라고");
  });

  it("가릴 수 없을 만큼 짧은 비밀 값이 있거나, 미리보기로 다 볼 수 없을 만큼 캡처가 많으면 만들지 않는다", async () => {
    await expect(service({ secrets: [...FAKE_SECRETS, "ab"] }).prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false })).rejects.toThrow("짧은");
    await expect(service({ maxImages: 1 }).prepare({ runId: "run-1", executionId: "exec-1", includePassScreens: false })).rejects.toThrow("미리보기로 모두 확인할 수 없다");
  });
});
