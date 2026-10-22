import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseExecution } from "./parse";
import { buildSecretSet, findSecretResidue, MASK, redactExecutionDir, redactText, secretVariants } from "./redact";
import { listFiles } from "./walk";
import { copyFixture, FAKE_ACCOUNT_ID, FAKE_ACCOUNT_PW, FAKE_SECRETS, fixtureDir, FIXTURE_NAMES } from "./test-fixtures";

const tmp = (p: string) => join(mkdtempSync(join(tmpdir(), "qa-redact-")), p);
const hashDir = (dir: string) =>
  listFiles(dir)
    .map((f) => `${f}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`)
    .join("\n");

describe("표기 변형과 문자열 가림", () => {
  it("JSON·XML·URL 표기와 파일 이름의 _ 변형을 만든다", () => {
    expect(secretVariants('a"b& c')).toEqual(['a"b& c', 'a\\"b& c', "a&quot;b&amp; c", "a%22b%26%20c", 'a"b&_c']);
  });

  it("값과 모양 규칙(JWT, Bearer, 토큰 필드)을 가린다", () => {
    const set = buildSecretSet(["s3cret-value"]);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl";
    const r = redactText(`pw=s3cret-value Authorization: Bearer abcdefghijklmnop token=${jwt} {"access_token":"zzz-111","name":"kim"}`, set);
    expect(r.text).toBe(`pw=${MASK} Authorization: Bearer ${MASK} token=${MASK} {"access_token":"${MASK}","name":"kim"}`);
    expect(r.values).toBe(1);
    expect(r.patterns).toEqual({ jwt: 1, bearer: 1, "json-secret-field": 1 });
  });

  it("한글 비밀은 NFC·NFD 두 정규화 모두 가린다", () => {
    const set = buildSecretSet(["홍길동 계정"]);
    const r = redactText(`a ${"홍길동 계정".normalize("NFD")} b ${"홍길동_계정".normalize("NFC")}`, set);
    expect(r.text).toBe(`a ${MASK} b ${MASK}`);
  });

  it("3자 미만 비밀은 가리지 못한 개수로 보고한다", () => {
    expect(buildSecretSet(["ab", "", "abc"]).unredactable).toBe(1);
  });
});

describe("실제 산출물 픽스처 가림", () => {
  it.each(FIXTURE_NAMES)("%s: 원본은 그대로, 사본에는 비밀이 남지 않고, 파싱 결과는 같다", (name) => {
    const raw = fixtureDir(name);
    const before = hashDir(raw);
    const out = tmp("redacted");
    const report = redactExecutionDir(raw, out, { secrets: FAKE_SECRETS });

    expect(hashDir(raw)).toBe(before);
    expect(report.unredactableSecrets).toBe(0);
    expect(findSecretResidue(out, FAKE_SECRETS)).toEqual([]);

    const a = parseExecution({ dir: raw });
    const b = parseExecution({ dir: out });
    expect(b.status).toBe(a.status);
    expect(b.failure?.kind).toBe(a.failure?.kind);
    expect(b.steps.map((s) => [s.command, s.status, s.description])).toEqual(a.steps.map((s) => [s.command, s.status, s.description]));
    expect(b.artifacts.map((x) => x.kind)).toEqual(a.artifacts.map((x) => x.kind));
  });

  it("원본 픽스처에는 실제 비밀이 남는 자리에 가짜 값이 있다(가림 검사가 의미 있음)", () => {
    const where = (name: (typeof FIXTURE_NAMES)[number]) =>
      findSecretResidue(fixtureDir(name), FAKE_SECRETS).map((r) => r.path.replace(/^maestro\/[^/]+\/[^/]+\//, ""));
    expect(where("ios-fail")).toEqual(
      expect.arrayContaining(["console.log", "junit.xml", "commands.json", "logs/maestro.log", expect.stringMatching(/^screen-hierarchy\//)]),
    );
    expect(where("android-pass")).toEqual(expect.arrayContaining(["console.log", "commands.json", "logs/maestro.log"]));
  });

  it("commands.json 의 플로우 변수는 구조로 가리고 Maestro 변수는 남긴다", () => {
    const out = tmp("redacted");
    redactExecutionDir(fixtureDir("ios-fail"), out, { secrets: FAKE_SECRETS });
    const commandsPath = listFiles(out).find((f) => f.endsWith("commands.json")) ?? "";
    const commands = JSON.parse(readFileSync(commandsPath, "utf8")) as { command: Record<string, { env?: Record<string, string> }> }[];
    const env = commands[0]?.command["defineVariablesCommand"]?.env ?? {};
    expect(env["QA_FIXTURE_ACCOUNT_ID"]).toBe(MASK);
    expect(env["QA_FIXTURE_ACCOUNT_PW"]).toBe(MASK);
    expect(env["MAESTRO_DRIVER_STARTUP_TIMEOUT"]).toBe("90000");
    // 콘솔의 Maestro 인자 해석 경고(원문 값)와 JUnit 실패 메시지도 가려진다
    expect(readFileSync(join(out, "console.log"), "utf8")).toContain(`QA_FIXTURE_ACCOUNT_PW=${MASK}`);
    expect(readFileSync(join(out, "junit.xml"), "utf8")).toContain(`Text matching regex: ${MASK} 없음`);
  });

  it("비밀 목록을 주지 않아도 플로우 변수(-e) 값은 모든 파일에서 가린다", () => {
    const out = tmp("redacted");
    redactExecutionDir(fixtureDir("android-fail"), out, { secrets: [] });
    expect(findSecretResidue(out, FAKE_SECRETS)).toEqual([]);
  });

  it("캡처 같은 바이너리는 바이트 그대로 복사한다", () => {
    const out = tmp("redacted");
    redactExecutionDir(fixtureDir("ios-pass"), out, { secrets: FAKE_SECRETS });
    const png = listFiles(fixtureDir("ios-pass")).find((f) => f.endsWith(".png")) ?? "";
    const copy = listFiles(out).find((f) => f.endsWith(".png")) ?? "";
    expect(readFileSync(copy).equals(readFileSync(png))).toBe(true);
  });

  it("파일 이름에 비밀 값이 있으면 이름도 가리고, 스텝은 가린 이름의 파일을 가리킨다", () => {
    // 플로우에 값을 직접 쓰면 Maestro 가 실패 산출물 이름에 값을 넣는다. 그 상황을 만든다.
    const dir = copyFixture("ios-fail");
    const files = listFiles(dir);
    const commandsPath = files.find((f) => f.endsWith("commands.json")) ?? "";
    for (const f of files.filter((p) => p.includes("${QA_FIXTURE_ACCOUNT_ID}"))) renameSync(f, f.replace("${QA_FIXTURE_ACCOUNT_ID}", FAKE_ACCOUNT_ID));
    writeFileSync(commandsPath, readFileSync(commandsPath, "utf8").replaceAll("step-008-tapOnElement-${QA_FIXTURE_ACCOUNT_ID}", `step-008-tapOnElement-${FAKE_ACCOUNT_ID}`));
    expect(findSecretResidue(dir, FAKE_SECRETS).some((r) => r.inPath)).toBe(true);

    const out = tmp("redacted");
    const report = redactExecutionDir(dir, out, { secrets: FAKE_SECRETS });
    expect(report.renamedPaths).toBe(2);
    expect(findSecretResidue(out, FAKE_SECRETS)).toEqual([]);
    const parsed = parseExecution({ dir: out });
    expect(parsed.steps[5]?.failureScreenshot).toContain(`step-008-tapOnElement-${MASK}_없음.png`);
    expect(parsed.warnings).toEqual([]);
  });

  it("잔존 검사 결과에는 값이 들어가지 않는다", () => {
    const residue = findSecretResidue(fixtureDir("ios-fail"), FAKE_SECRETS);
    expect(residue.length).toBeGreaterThan(0);
    const text = JSON.stringify(residue);
    expect(text).not.toContain(FAKE_ACCOUNT_ID);
    expect(text).not.toContain("Pw&2026");
  });

  it("모양 규칙에 걸리는 값이 남아 있으면 잔존으로 보고한다", () => {
    const dir = tmp("residue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.log"), "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl\n");
    expect(findSecretResidue(dir, [])).toEqual([{ path: "app.log", occurrences: 0, inPath: false, patternMatches: 1 }]);
  });

  it("사본 폴더가 비어 있지 않거나 원본과 겹치면 거부한다", () => {
    const out = tmp("redacted");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "x"), "x");
    expect(() => redactExecutionDir(fixtureDir("ios-pass"), out, { secrets: FAKE_SECRETS })).toThrow(/비어 있지 않다/);
    expect(() => redactExecutionDir(fixtureDir("ios-pass"), join(fixtureDir("ios-pass"), "redacted"), { secrets: FAKE_SECRETS })).toThrow(/겹칠 수 없다/);
  });

  it("가림 보고서와 오류에는 비밀 값이 없다", () => {
    const report = redactExecutionDir(fixtureDir("ios-fail"), tmp("redacted"), { secrets: [...FAKE_SECRETS, "x"] });
    expect(report.unredactableSecrets).toBe(1);
    expect(JSON.stringify(report)).not.toContain(FAKE_ACCOUNT_ID);
    expect(JSON.stringify(report)).not.toContain(FAKE_ACCOUNT_PW);
  });
});
