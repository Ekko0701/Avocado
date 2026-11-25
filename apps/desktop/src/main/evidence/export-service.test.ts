import { redactExecutionDir, type JpegConverter } from "@qa/evidence";
import type { RunDetail } from "@qa/shared";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EvidenceExportError, EvidenceExportService, exportFolderName, writeBundleFolder } from "./export-service";

const FIXTURES = resolve(__dirname, "../../../../../packages/evidence/fixtures");
// packages/evidence/fixtures/README.md 의 가짜 값
const FAKE_SECRETS = ["qa-fixture-id-7f3a", 'fixture"Pw&2026'];
const toJpeg: JpegConverter = async (png) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png.subarray(0, 16)]);

let dir: string;
let home: string;
let picked: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-export-"));
  home = join(dir, "home");
  picked = join(home, "Downloads");
  mkdirSync(picked, { recursive: true });
  redactExecutionDir(join(FIXTURES, "ios-fail"), join(dir, "redacted"), { secrets: FAKE_SECRETS });
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

function service(opts: { status?: RunDetail["status"]; secrets?: string[]; jpeg?: JpegConverter; pick?: () => Promise<string | null> } = {}) {
  const picks: number[] = [];
  const revealed: string[] = [];
  let id = 0;
  const s = new EvidenceExportService({
    runs: { get: () => run(opts.status ?? "failed") },
    evidence: { redactedDir: () => join(dir, "redacted") },
    secrets: () => opts.secrets ?? [...FAKE_SECRETS],
    toJpeg: opts.jpeg ?? toJpeg,
    generator: "qa-tool test",
    pickFolder: async () => {
      picks.push(1);
      return opts.pick ? opts.pick() : picked;
    },
    reveal: (path) => revealed.push(path),
    home,
    now: () => new Date(2026, 9, 22, 10, 0),
    newId: () => `id-${(id += 1)}`,
  });
  return { s, picks, revealed };
}

const input = { runId: "run-1", executionId: "exec-1", includePassScreens: false };
const allText = (folder: string): string =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name)).toString("latin1"))
    .join("\n");

describe("증적 폴더로 내보내기 (ADR 0036 결정 9, T-126)", () => {
  it("정책 스위치(D11)·GitHub 설정·워크스페이스 출처 없이 미리보기 → 개인정보 확인 → 고른 폴더 안의 새 폴더에 보고서와 캡처를 쓰고 비밀 값은 없다", async () => {
    const { s, picks } = service();
    const preview = await s.prepare(input);
    expect(preview).toMatchObject({ bundleId: "id-1", folderName: "avocado-evidence-TC-0009-run-1", blocked: false, residue: [] });
    expect(preview.files.map((f) => f.path)).toEqual(expect.arrayContaining(["run.json", "report.md", "logs/maestro-excerpt.txt"]));
    expect(picks).toEqual([]);

    const record = await s.export({ bundleId: "id-1", privacyConfirmed: true });
    expect(record).toEqual({ exportId: "id-2", folder: "~/Downloads/avocado-evidence-TC-0009-run-1", files: preview.files.length, bytes: preview.totalBytes });
    const folder = join(picked, "avocado-evidence-TC-0009-run-1");
    expect(readdirSync(picked)).toEqual(["avocado-evidence-TC-0009-run-1"]);
    expect(readFileSync(join(folder, "report.md"), "utf8")).toContain("TC-0009");
    expect(readdirSync(join(folder, "screens")).some((f) => f.endsWith(".jpg"))).toBe(true);
    // 저장소용 색인 줄은 쓰지 않는다
    expect(existsSync(join(folder, "index"))).toBe(false);
    const text = allText(folder);
    for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
  });

  it("같은 실행을 다시 내보내면 앞의 폴더를 덮어쓰지 않고 -2 폴더를 만든다. 한 미리보기로는 한 번만 쓴다", async () => {
    const { s } = service();
    await s.prepare(input);
    await s.export({ bundleId: "id-1", privacyConfirmed: true });
    await expect(s.export({ bundleId: "id-1", privacyConfirmed: true })).rejects.toThrow("미리보기가 없거나 만료");
    await s.prepare(input);
    const again = await s.export({ bundleId: "id-3", privacyConfirmed: true });
    expect(again?.folder).toBe("~/Downloads/avocado-evidence-TC-0009-run-1-2");
    expect(readdirSync(picked).sort()).toEqual(["avocado-evidence-TC-0009-run-1", "avocado-evidence-TC-0009-run-1-2"]);
  });

  it("묶음에 비밀 값이 남으면 막고(미리보기에 경로·개수만) 폴더를 고르지도 쓰지도 않는다", async () => {
    // 텍스트는 묶을 때 다시 가리므로, 가리지 못하는 이미지 바이트에 값이 들어간 경우를 흉내 낸다
    const { s, picks } = service({ jpeg: async () => Buffer.from(`JPEG comment ${FAKE_SECRETS[1]}`) });
    const preview = await s.prepare(input);
    expect(preview.blocked).toBe(true);
    expect(preview.bundleId).toBeNull();
    expect(JSON.stringify(preview.residue)).not.toContain(FAKE_SECRETS[1]);
    await expect(s.export({ bundleId: "id-1", privacyConfirmed: true })).rejects.toThrow(EvidenceExportError);
    expect(picks).toEqual([]);
    expect(readdirSync(picked)).toEqual([]);
  });

  it("가릴 수 없을 만큼 짧은 비밀 값이 있거나 실행이 끝나지 않았으면 만들지 않는다", async () => {
    await expect(service({ secrets: [...FAKE_SECRETS, "ab"] }).s.prepare(input)).rejects.toThrow(/짧은\(\d자 미만\) 비밀 값이 있어 내보내지 않는다/);
    await expect(service({ status: "running" }).s.prepare(input)).rejects.toThrow("끝나지 않은 실행은 내보내지 않는다");
    await expect(service().s.prepare({ ...input, executionId: "nope" })).rejects.toThrow("실행을 찾지 못했다");
  });

  it("개인정보 확인 없이는 폴더를 고르지도 쓰지도 않는다", async () => {
    const { s, picks } = service();
    await s.prepare(input);
    await expect(s.export({ bundleId: "id-1", privacyConfirmed: false as unknown as true })).rejects.toThrow("개인정보 확인이 필요하다");
    expect(picks).toEqual([]);
    expect(readdirSync(picked)).toEqual([]);
  });

  it("미리보기 뒤 계정 값이 늘면 쓰기 직전 검사에서 막고 아무것도 남기지 않는다", async () => {
    const secrets = [...FAKE_SECRETS];
    const { s } = service({ secrets });
    await s.prepare(input);
    // report.md 에 들어간 흐름 이름 일부가 나중에 비밀 값으로 등록됐다고 치자
    secrets.push("fixture iOS 설정 검색 실패");
    await expect(s.export({ bundleId: "id-1", privacyConfirmed: true })).rejects.toThrow("비밀 값이 남아");
    expect(readdirSync(picked)).toEqual([]);
  });

  it("폴더 고르기를 취소하면 null 이고, 미리보기는 남아 다시 고를 수 있다", async () => {
    let answer: string | null = null;
    const { s, picks } = service({ pick: async () => answer });
    await s.prepare(input);
    expect(await s.export({ bundleId: "id-1", privacyConfirmed: true })).toBeNull();
    expect(readdirSync(picked)).toEqual([]);
    answer = picked;
    expect((await s.export({ bundleId: "id-1", privacyConfirmed: true }))?.folder).toBe("~/Downloads/avocado-evidence-TC-0009-run-1");
    expect(picks).toHaveLength(2);
  });

  it("Finder 에서 보기는 이번에 내보낸 폴더만 연다", async () => {
    const { s, revealed } = service();
    await s.prepare(input);
    const record = await s.export({ bundleId: "id-1", privacyConfirmed: true });
    expect(s.reveal({ exportId: record?.exportId ?? "" })).toEqual({ opened: true });
    expect(revealed).toEqual([join(picked, "avocado-evidence-TC-0009-run-1")]);
    expect(() => s.reveal({ exportId: "other" })).toThrow("이번에 내보낸 폴더가 아니다");
  });
});

describe("writeBundleFolder", () => {
  it("묶음의 경로가 새 폴더 밖을 가리키면 고른 폴더에 아무것도 남기지 않고 거절한다", () => {
    const content = Buffer.from("x");
    for (const path of ["../escape.txt", "screens/../../escape.txt", "/tmp/escape.txt"]) {
      expect(() => writeBundleFolder(picked, "avocado-evidence-x", [{ path: "report.md", kind: "report", content }, { path, kind: "log", content }])).toThrow("내보낼 폴더 밖");
    }
    expect(readdirSync(picked)).toEqual([]);
    expect(readdirSync(home).sort()).toEqual(["Downloads"]);
  });

  it("폴더 이름은 테스트 케이스 id 와 실행 id 앞 8자, 두 번째 시도부터는 회차를 붙이고 파일 이름에 쓸 수 없는 글자를 바꾼다", () => {
    expect(exportFolderName("TC-0101", "1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d", 1)).toBe("avocado-evidence-TC-0101-1a2b3c4d");
    expect(exportFolderName("TC-0101", "1a2b3c4d-5e6f", 2)).toBe("avocado-evidence-TC-0101-1a2b3c4d-attempt-2");
    expect(exportFolderName("../a b", "../../x", 1)).toBe("avocado-evidence-a-b-x");
  });
});
