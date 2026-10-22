import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureDir } from "../../../../../packages/evidence/src/test-fixtures";
import { AppDatabase } from "../db/database";
import { EvidenceError, EvidenceService } from "./evidence-service";

let dir: string;
let db: AppDatabase;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-evidence-svc-"));
  db = AppDatabase.open(join(dir, "db.sqlite"));
  root = join(dir, "evidence");
  const summary = JSON.stringify({ app: "settings", flowName: "x", flowPath: "/x.yaml", tcId: "adhoc", target: "ios", deviceId: "d", deviceName: "d", buildId: null, buildLabel: null, attempts: 1, flaky: false, failureMessage: null });
  db.db.prepare("INSERT INTO run (id, workspace, trigger, status, summary, created_at) VALUES ('r1', 'local', 'manual', 'failed', ?, '2026-10-22T00:00:00.000Z')").run(summary);
  db.db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status, evidence_dir) VALUES ('e1', 'r1', 'adhoc', 'ios', '/x.yaml', 'failed', 'r1/e1')").run();
  db.db.prepare("INSERT INTO execution (id, run_id, tc_id, target, flow_path, status, evidence_dir) VALUES ('e2', 'r1', 'adhoc', 'ios', '/x.yaml', 'running', 'r1/e2')").run();
  cpSync(fixtureDir("ios-fail"), join(root, "r1", "e1", "redacted"), { recursive: true });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const svc = (opts: { maxTextBytes?: number } = {}) => new EvidenceService({ db, evidenceRoot: root, ...opts });

describe("증적 열람", () => {
  it("산출물 목록과 실패 캡처(data URL)", () => {
    const artifacts = svc().list("r1", "e1");
    const shot = artifacts.find((a) => a.kind === "failure_screenshot");
    expect(shot?.stepIndex).toBe(5);
    const file = svc().file("r1", "e1", shot?.path ?? "");
    expect(file.kind).toBe("image");
    if (file.kind === "image") {
      expect(file.mime).toBe("image/png");
      expect(file.dataUrl.startsWith("data:image/png;base64,iVBOR")).toBe(true);
      expect(file.bytes).toBe(shot?.bytes);
    }
  });

  it("작은 텍스트는 그대로, 큰 텍스트는 끝부분과 원래 줄 번호", () => {
    const log = svc().list("r1", "e1").find((a) => a.kind === "maestro_log")?.path ?? "";
    const whole = svc().file("r1", "e1", log);
    expect(whole).toMatchObject({ kind: "text", truncated: false, firstLine: 1 });
    const big = join(root, "r1", "e1", "redacted", "console-big.log");
    writeFileSync(big, Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"));
    const tail = svc({ maxTextBytes: 100 }).file("r1", "e1", "console-big.log");
    expect(tail.kind === "text" && tail.truncated).toBe(true);
    if (tail.kind === "text") {
      const first = tail.text.split("\n")[0];
      expect(first).toBe(`line ${tail.firstLine}`);
      expect(tail.text.endsWith("line 1000")).toBe(true);
    }
  });

  it("로그 검색: 대소문자 무시, 파일·줄 번호", () => {
    const r = svc().search("r1", "e1", "element NOT found");
    expect(r.truncated).toBe(false);
    const paths = new Set(r.matches.map((m) => m.path.split("/").pop()));
    expect(paths).toEqual(new Set(["console.log", "junit.xml", "maestro.log"]));
    expect(r.matches.every((m) => m.line > 0 && m.text.toLowerCase().includes("element not found"))).toBe(true);
  });

  it("화면 트리를 들여쓰기 목록으로 편다", () => {
    const h = svc().list("r1", "e1").find((a) => a.kind === "screen_hierarchy")?.path ?? "";
    const view = svc().hierarchy("r1", "e1", h);
    expect(view.truncated).toBe(false);
    expect(view.nodes.length).toBeGreaterThan(5);
    // 실패 시점은 검색 화면이고 키보드가 떠 있다
    expect(view.nodes.some((n) => n.id === "magnifyingglass")).toBe(true);
    expect(view.nodes.some((n) => n.id === "Search")).toBe(true);
    expect(view.nodes[0]?.depth).toBeGreaterThanOrEqual(0);
  });
});

describe("증적 폴더 밖은 열지 않는다", () => {
  it("상위 경로·절대 경로·없는 파일", () => {
    expect(() => svc().file("r1", "e1", "../../../db.sqlite")).toThrow(/밖의 경로/);
    expect(() => svc().file("r1", "e1", "maestro/../../e1/redacted/console.log")).toThrow(/밖의 경로/);
    expect(() => svc().file("r1", "e1", "/etc/hosts")).toThrow(/밖의 경로/);
    expect(() => svc().file("r1", "e1", "nope.log")).toThrow(/없다/);
  });

  it("심볼릭 링크와 원본(raw) 폴더", () => {
    symlinkSync("/etc/hosts", join(root, "r1", "e1", "redacted", "hosts.log"));
    expect(() => svc().file("r1", "e1", "hosts.log")).toThrow(/심볼릭 링크/);
    mkdirSync(join(root, "r1", "e1", "raw"), { recursive: true });
    writeFileSync(join(root, "r1", "e1", "raw", "secret.log"), "raw");
    expect(() => svc().file("r1", "e1", "../raw/secret.log")).toThrow(/밖의 경로/);
  });

  it("다른 실행의 id 조합, 가린 사본이 없는 실행", () => {
    expect(() => svc().list("other-run", "e1")).toThrow(EvidenceError);
    expect(() => svc().list("r1", "e2")).toThrow(/가린 증적이 없다/);
    expect(readdirSync(join(root, "r1"))).toEqual(["e1"]);
  });
});
