import { afterEach, describe, expect, it } from "vitest";
import { GitHubProvider } from "./github";
import { RemoteError } from "./provider";
import { startFakeGitHub, type FakeGitHub } from "./testing/fake-github";

const TOKEN = "github_pat_TEST_0123456789abcdefghijklmnopqrstuvwxyz";
const WS = { owner: "acme", repo: "qa-workspace" };
let fake: FakeGitHub | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function provider(token: string | null = TOKEN, logs: unknown[] = []) {
  return new GitHubProvider({ token: () => token, apiUrl: fake?.url, log: (e) => logs.push(e) });
}

describe("GitHubProvider", () => {
  it("토큰 확인: 로그인과 저장소 권한. 토큰은 헤더로만 보내고 URL·로그에 없다", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-workspace": { push: true }, "acme/qa-evidence-2026": { push: false } } });
    const logs: unknown[] = [];
    const r = await provider(TOKEN, logs).verify([WS, { owner: "acme", repo: "qa-evidence-2026" }, { owner: "acme", repo: "nope" }]);
    expect(r).toEqual({
      login: "qa-bot",
      repos: [
        { owner: "acme", repo: "qa-workspace", exists: true, canPush: true },
        { owner: "acme", repo: "qa-evidence-2026", exists: true, canPush: false },
        { owner: "acme", repo: "nope", exists: false, canPush: false },
      ],
    });
    expect(fake.requests.every((q) => q.authorized)).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain(TOKEN);
    expect(logs).toContainEqual(expect.objectContaining({ method: "GET", path: "/user", status: 200 }));
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("저장소 목록: 토큰으로 볼 수 있는 저장소와 쓰기 권한(사용자마다 다른 이름을 고르게 한다)", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "me/Avocado-workspace": { push: true }, "me/Avocado-qa-evidence-2026": { push: true }, "acme/read-only": { push: false } } });
    const logs: unknown[] = [];
    expect(await provider(TOKEN, logs).listRepos()).toEqual([
      { owner: "acme", repo: "read-only", private: true, canPush: false },
      { owner: "me", repo: "Avocado-qa-evidence-2026", private: true, canPush: true },
      { owner: "me", repo: "Avocado-workspace", private: true, canPush: true },
    ]);
    expect(logs).toContainEqual(expect.objectContaining({ method: "GET", path: "/user/repos", status: 200 }));
    await expect(provider("github_pat_WRONG").listRepos()).rejects.toThrow("저장소 목록: 토큰이 유효하지 않거나 만료됐다");
  });

  it("틀린 토큰·토큰 없음은 토큰 없는 메시지로 실패한다", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: {} });
    const wrong = "github_pat_WRONG_zzzzzzzzzzzzzzzzzzzzzzzzzz";
    const err = await provider(wrong).verify([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).status).toBe(401);
    expect((err as Error).message).toContain("토큰이 유효하지 않거나");
    expect((err as Error).message).not.toContain(wrong);
    await expect(provider(null).verify([])).rejects.toThrow(/토큰이 없다/);
  });

  it("서버 오류 본문에 토큰이 되돌아와도 오류 메시지에서 지운다", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-tool": { push: false } }, leakAuthOnReleaseError: true });
    const err = await provider().getLatestRelease({ owner: "acme", repo: "qa-tool" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as Error).message).toContain("최신 릴리스 확인");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("PR, 최신 릴리스, 주소", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-workspace": { push: true }, "acme/qa-tool": { push: false } }, release: { tag: "v0.2.0" } });
    const p = provider();
    await expect(p.createPullRequest({ repo: WS, head: "qa/me/TC-0101", base: "main", title: "TC-0101", body: "본문" })).resolves.toEqual({
      number: 7,
      url: "https://github.com/acme/qa-workspace/pull/7",
    });
    await expect(p.getLatestRelease({ owner: "acme", repo: "qa-tool" })).resolves.toMatchObject({ tag: "v0.2.0", name: "v0.2.0" });
    expect(p.cloneUrl(WS)).toBe("https://github.com/acme/qa-workspace.git");
    expect(p.fileUrl(WS, "runs/2026/10/22/r 1/report.md", "main")).toBe("https://github.com/acme/qa-workspace/blob/main/runs/2026/10/22/r%201/report.md");
  });

  it("릴리스가 없으면 null", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-tool": { push: false } }, release: null });
    await expect(provider().getLatestRelease({ owner: "acme", repo: "qa-tool" })).resolves.toBeNull();
  });

  it("릴리스 파일 받기: API 로 octet-stream, 크기 상한을 넘으면 받지 않는다", async () => {
    const dmg = Buffer.from("fake dmg bytes");
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-tool": { push: false } }, release: { tag: "v0.3.0", assets: [{ name: "Avocado-0.3.0-arm64.dmg", content: dmg }] } });
    const repo = { owner: "acme", repo: "qa-tool" };
    const release = await provider().getLatestRelease(repo);
    const asset = release?.assets[0];
    expect(asset).toMatchObject({ id: 1, name: "Avocado-0.3.0-arm64.dmg", size: dmg.length, url: "https://github.com/acme/qa-tool/releases/download/v0.3.0/Avocado-0.3.0-arm64.dmg" });
    expect((await provider().downloadReleaseAsset(repo, { id: 1, size: dmg.length }, 1024)).equals(dmg)).toBe(true);
    await expect(provider().downloadReleaseAsset(repo, { id: 1, size: dmg.length }, 4)).rejects.toThrow("너무 크다");
  });

  it("커밋 올리기: 브랜치가 앞서 나가면 최신 위에서 다시 만든다(최대 3회)", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-evidence-2026": { push: true } }, refConflicts: 2 });
    const repo = { owner: "acme", repo: "qa-evidence-2026" };
    const r = await provider().commitFiles({ repo, branch: "main", message: "evidence: TC-0101 ios passed r1", files: [{ path: "runs/a.json", content: "{}" }, { path: "runs/b.md", content: "# b" }] });
    expect(r.url).toMatch(/^https:\/\/github\.com\/acme\/qa-evidence-2026\/commit\/[0-9a-f]{40}$/);
    expect(fake.requests.filter((q) => q.method === "PATCH")).toHaveLength(3);
    expect(fake.requests.filter((q) => q.path.endsWith("/git/blobs"))).toHaveLength(2);
    await fake.close();
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-evidence-2026": { push: true } }, refConflicts: 5 });
    await expect(provider().commitFiles({ repo, branch: "main", message: "m", files: [{ path: "x", content: "y" }] })).rejects.toThrow(RemoteError);
    expect(fake.requests.filter((q) => q.method === "PATCH")).toHaveLength(3);
  });

  it("커밋 올리기: 색인 파일에 줄을 덧붙인다. 충돌로 다시 만들어도 한 번만 붙는다", async () => {
    fake = await startFakeGitHub({ token: TOKEN, repos: { "acme/qa-evidence-2026": { push: true } }, refConflicts: 1 });
    const repo = { owner: "acme", repo: "qa-evidence-2026" };
    await provider().commitFiles({ repo, branch: "main", message: "evidence: 1", files: [{ path: "runs/r1/report.md", content: "# r1" }], appendLines: [{ path: "index/2026-10.jsonl", lines: ['{"run":"r1"}'] }] });
    await provider().commitFiles({ repo, branch: "main", message: "evidence: 2", files: [{ path: "runs/r2/report.md", content: Buffer.from("# r2") }], appendLines: [{ path: "index/2026-10.jsonl", lines: ['{"run":"r2"}'] }] });
    const files = fake.files();
    expect(files.get("index/2026-10.jsonl")?.toString("utf8")).toBe('{"run":"r1"}\n{"run":"r2"}\n');
    expect(files.get("runs/r1/report.md")?.toString("utf8")).toBe("# r1");
    expect(files.get("runs/r2/report.md")?.toString("utf8")).toBe("# r2");
    expect(fake.commitMessages()).toEqual(["init", "someone else", "evidence: 1", "evidence: 2"]);
  });
});
