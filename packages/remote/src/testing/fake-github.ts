import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** 테스트 전용 가짜 GitHub REST API. 쓰는 엔드포인트만 흉내 낸다 */
export interface FakeGitHubOptions {
  token: string;
  repos: Record<string, { push: boolean }>;
  /** 처음 N 번의 ref 갱신을 fast-forward 아님(422)으로 거부한다 */
  refConflicts?: number;
  /** 최신 릴리스 요청에 500 을 내고 본문에 받은 Authorization 헤더를 그대로 담는다(오류 메시지 가림 시험) */
  leakAuthOnReleaseError?: boolean;
  release?: { tag: string; assets?: { name: string; content: Buffer }[] } | null;
  /** 공개 저장소(owner/repo): Authorization 없는 GET 을 받는다. 틀린 토큰은 그대로 401 */
  publicRepos?: string[];
}

export interface FakeGitHub {
  url: string;
  requests: { method: string; path: string; authorized: boolean }[];
  /** 받은 PR 요청 */
  pulls: { repo: string; head: string; base: string; title: string; body: string }[];
  /** 브랜치 머리 커밋의 파일(경로 → 내용). Git Data API 로 올린 결과를 확인한다 */
  files(): Map<string, Buffer>;
  /** 머리부터 거슬러 올라간 커밋 메시지(오래된 것 먼저) */
  commitMessages(): string[];
  close(): Promise<void>;
}

export async function startFakeGitHub(opts: FakeGitHubOptions): Promise<FakeGitHub> {
  const requests: FakeGitHub["requests"] = [];
  const pulls: FakeGitHub["pulls"] = [];
  let conflicts = opts.refConflicts ?? 0;
  let n = 0;
  const sha = () => (++n).toString(16).padStart(40, "0");
  // 아주 작은 git 객체 저장소(모든 저장소가 하나를 같이 쓴다)
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const emptyTree = sha();
  trees.set(emptyTree, new Map());
  let head = sha();
  commits.set(head, { tree: emptyTree, parents: [], message: "init" });
  const filesAt = (commit: string) => trees.get(commits.get(commit)?.tree ?? emptyTree) ?? new Map<string, string>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
      const auth = String(req.headers["authorization"] ?? "");
      const authorized = auth === `token ${opts.token}` || auth === `Bearer ${opts.token}`;
      requests.push({ method: req.method ?? "", path, authorized });
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
      const anonymousPublicRead = auth === "" && req.method === "GET" && m !== null && (opts.publicRepos ?? []).includes(`${m[1]}/${m[2]}`);
      if (!authorized && !anonymousPublicRead) return send(401, { message: "Bad credentials" });
      if (path === "/user" && req.method === "GET") return send(200, { login: "qa-bot" });
      if (path === "/user/repos" && req.method === "GET") {
        return send(
          200,
          Object.entries(opts.repos)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([full, r]) => ({ name: full.split("/")[1], owner: { login: full.split("/")[0] }, private: true, permissions: { pull: true, push: r.push } })),
        );
      }
      if (!m) return send(404, { message: "Not Found" });
      const key = `${m[1]}/${m[2]}`;
      const repo = opts.repos[key];
      if (!repo) return send(404, { message: "Not Found" });
      const rest = m[3] ?? "";
      if (rest === "" && req.method === "GET") return send(200, { full_name: key, permissions: { pull: true, push: repo.push } });
      if (rest === "/pulls" && req.method === "GET") {
        return send(
          200,
          pulls
            .map((p, i) => ({ ...p, number: 7 + i }))
            .filter((p) => p.repo === key)
            .map((p) => ({ number: p.number, title: p.title, html_url: `https://github.com/${key}/pull/${p.number}`, head: { ref: p.head }, user: { login: "qa-bot" }, created_at: "2026-10-22T00:00:00Z", state: "open" })),
        );
      }
      if (rest === "/pulls" && req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { head: string; base: string; title: string; body: string };
        pulls.push({ repo: key, head: body.head, base: body.base, title: body.title, body: body.body });
        const number = 6 + pulls.length;
        return send(201, { number, html_url: `https://github.com/${key}/pull/${number}` });
      }
      if (rest === "/releases/latest") {
        if (opts.leakAuthOnReleaseError) return send(500, { message: `internal error while handling authorization: ${auth}` });
        if (!opts.release) return send(404, { message: "Not Found" });
        const base = `http://${req.headers.host ?? "127.0.0.1"}`;
        const assets = (opts.release.assets ?? []).map((a, i) => ({
          id: i + 1,
          name: a.name,
          size: a.content.length,
          url: `${base}/repos/${key}/releases/assets/${i + 1}`,
          browser_download_url: `https://github.com/${key}/releases/download/${opts.release?.tag ?? ""}/${a.name}`,
        }));
        return send(200, { tag_name: opts.release.tag, name: null, html_url: `https://github.com/${key}/releases/${opts.release.tag}`, published_at: "2026-10-01T00:00:00Z", assets });
      }
      const asset = /^\/releases\/assets\/(\d+)$/.exec(rest);
      if (asset && req.method === "GET") {
        const a = opts.release?.assets?.[Number(asset[1]) - 1];
        if (!a) return send(404, { message: "Not Found" });
        if (req.headers["accept"] !== "application/octet-stream") return send(415, { message: "octet-stream 만" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": a.content.length }).end(a.content);
        return;
      }
      const json = () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (rest === "/git/blobs" && req.method === "POST") {
        const body = json() as { content: string; encoding?: string };
        const id = sha();
        blobs.set(id, Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"));
        return send(201, { sha: id });
      }
      if (rest.startsWith("/git/ref/heads/") && req.method === "GET") return send(200, { object: { sha: head } });
      if (rest.startsWith("/git/commits/") && req.method === "GET") {
        const id = rest.split("/").pop() ?? "";
        const c = commits.get(id);
        return c ? send(200, { sha: id, tree: { sha: c.tree } }) : send(404, { message: "Not Found" });
      }
      if (rest === "/git/trees" && req.method === "POST") {
        const body = json() as { base_tree?: string; tree: { path: string; sha: string }[] };
        const files = new Map(trees.get(body.base_tree ?? emptyTree) ?? []);
        for (const e of body.tree) files.set(e.path, e.sha);
        const id = sha();
        trees.set(id, files);
        return send(201, { sha: id });
      }
      if (rest === "/git/commits" && req.method === "POST") {
        const body = json() as { message: string; tree: string; parents: string[] };
        const id = sha();
        commits.set(id, { tree: body.tree, parents: body.parents, message: body.message });
        return send(201, { sha: id });
      }
      if (rest.startsWith("/git/refs/heads/") && req.method === "PATCH") {
        if (conflicts > 0) {
          conflicts -= 1;
          // 다른 사람이 먼저 올렸다
          const other = sha();
          commits.set(other, { tree: commits.get(head)?.tree ?? emptyTree, parents: [head], message: "someone else" });
          head = other;
          return send(422, { message: "Update is not a fast forward" });
        }
        const next = (json() as { sha: string }).sha;
        if (!commits.get(next)?.parents.includes(head)) return send(422, { message: "Update is not a fast forward" });
        head = next;
        return send(200, { object: { sha: head } });
      }
      if (rest.startsWith("/contents/") && req.method === "GET") {
        const ref = new URL(req.url ?? "", "http://x").searchParams.get("ref") ?? head;
        const blob = filesAt(ref).get(rest.slice("/contents/".length));
        const content = blob ? blobs.get(blob) : undefined;
        return content ? send(200, { type: "file", encoding: "base64", content: content.toString("base64"), sha: blob }) : send(404, { message: "Not Found" });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    pulls,
    files: () => new Map([...filesAt(head)].map(([p, b]) => [p, blobs.get(b) ?? Buffer.alloc(0)])),
    commitMessages: () => {
      const out: string[] = [];
      let c = commits.get(head);
      while (c) {
        out.unshift(c.message);
        c = commits.get(c.parents[0] ?? "");
      }
      return out;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
