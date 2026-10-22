import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeGitHub } from "../../../packages/remote/src/testing/fake-github";
import { startGitHttp } from "../../../packages/remote/src/testing/git-http";

const EXAMPLE = resolve(__dirname, "../../../examples/qa-workspace");

/** 예시 워크스페이스로 만든 bare 저장소 + 로컬 git HTTP 서버 + 가짜 GitHub API (E2E 전용) */
export async function startFakeWorkspaceRemote(token: string) {
  const dir = mkdtempSync(join(tmpdir(), "qa-e2e-wsremote-"));
  const env = { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("/usr/bin/git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.test", ...args], { cwd, env }).toString().trim();
  const seed = join(dir, "seed");
  cpSync(EXAMPLE, seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "template");
  const bare = join(dir, "srv", "acme", "qa-workspace.git");
  mkdirSync(join(dir, "srv", "acme"), { recursive: true });
  git(dir, "clone", "-q", "--bare", seed, bare);
  git(bare, "config", "http.receivepack", "true");
  const gitServer = await startGitHttp({ root: join(dir, "srv"), password: token });
  // 저장소 고르기(마법사·설정)를 위해 올해 증적 저장소도 둔다
  const api = await startFakeGitHub({ token, repos: { "acme/qa-workspace": { push: true }, [`acme/qa-evidence-${new Date().getFullYear()}`]: { push: true } } });
  return {
    bare,
    git,
    api,
    gitServer,
    env: { QA_E2E_GITHUB_API: api.url, QA_E2E_GITHUB_WEB: gitServer.url },
    close: async () => {
      await gitServer.close();
      await api.close();
    },
  };
}
