import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskpassServer } from "./askpass";
import { runGit } from "./git";
import { startGitHttp } from "./testing/git-http";

const TOKEN = "github_pat_GIT_0123456789abcdefghijklmnopqrstuvwxyz";
let dir: string;
let home: string;
let store: string;
let server: Awaited<ReturnType<typeof startGitHttp>>;
let askpass: AskpassServer;

const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });

function allFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return [];
    return st.isDirectory() ? allFiles(p) : st.isFile() ? [p] : [];
  });
}
const filesWithToken = (d: string) => allFiles(d).filter((f) => readFileSync(f).includes(Buffer.from(TOKEN)) || readFileSync(f).includes(Buffer.from(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"))));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "qa-gitauth-"));
  home = join(dir, "home");
  mkdirSync(home);
  store = join(dir, "credential-store");
  // 사용자 전역 설정에 토큰을 파일로 저장하는 도우미가 있어도 쓰이면 안 된다
  writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = QA Bot\n\temail = qa@example.test\n[credential]\n\thelper = store --file ${store}\n`);
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# ws\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  mkdirSync(join(dir, "srv"));
  git(dir, "clone", "-q", "--bare", seed, join(dir, "srv", "ws.git"));
  git(join(dir, "srv", "ws.git"), "config", "http.receivepack", "true");
  server = await startGitHttp({ root: join(dir, "srv"), password: TOKEN });
  askpass = await AskpassServer.start();
});
afterAll(async () => {
  await server.close();
  await askpass.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("git 인증(GIT_ASKPASS)", () => {
  it("clone·push 가 되고, 토큰은 원격 주소·설정·출력·디스크 어디에도 없다", async () => {
    // 부모 환경의 추적 변수(인증 헤더를 로그에 쓴다)는 git 에 넘어가지 않아야 한다
    process.env["GIT_TRACE"] = "1";
    process.env["GIT_CURL_VERBOSE"] = "1";
    try {
      const session = askpass.session({ username: "x-access-token", password: TOKEN });
      expect(JSON.stringify(session.env)).not.toContain(TOKEN);
      const clone = await runGit(["clone", `${server.url}/ws.git`, "work"], { cwd: dir, askpass: session, home, secrets: [TOKEN] });
      expect(clone.code, clone.stderr).toBe(0);
      const work = join(dir, "work");
      writeFileSync(join(work, "TC-0101.md"), "# TC\n");
      expect((await runGit(["add", "."], { cwd: work, home })).code).toBe(0);
      expect((await runGit(["commit", "-q", "-m", "TC-0101"], { cwd: work, home })).code).toBe(0);
      const push = await runGit(["push", "origin", "HEAD:refs/heads/qa/test"], { cwd: work, askpass: session, home, secrets: [TOKEN] });
      expect(push.code, push.stderr).toBe(0);
      session.dispose();

      expect(server.seen.authorized).toBeGreaterThan(0);
      expect(askpass.answered).toBeGreaterThan(0);
      expect(readFileSync(join(work, ".git", "config"), "utf8")).toContain(`url = ${server.url}/ws.git`);
      for (const out of [clone.stdout, clone.stderr, push.stdout, push.stderr]) {
        expect(out).not.toContain(TOKEN);
        expect(out).not.toMatch(/authorization:/i);
        expect(out).not.toMatch(/^trace:|curl/im);
      }
      expect(existsSync(store)).toBe(false);
      expect(filesWithToken(dir)).toEqual([]);
      expect(readFileSync(askpass.scriptPath, "utf8")).not.toContain(TOKEN);
      expect(statSync(askpass.scriptPath).mode & 0o077).toBe(0);
    } finally {
      delete process.env["GIT_TRACE"];
      delete process.env["GIT_CURL_VERBOSE"];
    }
  });

  it("도우미가 없거나, nonce 가 틀리거나, 세션이 끝났으면 인증하지 못하고 프롬프트로 멈추지 않는다", async () => {
    const started = Date.now();
    const none = await runGit(["ls-remote", `${server.url}/ws.git`], { cwd: dir, home, timeoutMs: 30_000 });
    expect(none.code).not.toBe(0);

    const session = askpass.session({ username: "x-access-token", password: TOKEN });
    const forged = { ...session, env: { ...session.env, QA_ASKPASS_NONCE: "0".repeat(48) } };
    expect((await runGit(["ls-remote", `${server.url}/ws.git`], { cwd: dir, askpass: forged, home, timeoutMs: 30_000 })).code).not.toBe(0);

    session.dispose();
    expect((await runGit(["ls-remote", `${server.url}/ws.git`], { cwd: dir, askpass: session, home, timeoutMs: 30_000 })).code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(existsSync(store)).toBe(false);
  });
});
