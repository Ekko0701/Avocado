import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** 테스트 전용 git smart HTTP 서버(git http-backend). Basic 인증의 비밀번호가 토큰과 같아야 한다 */
export async function startGitHttp(opts: { root: string; password: string; gitPath?: string }) {
  const seen = { authorized: 0, rejected: 0 };
  const server = createServer((req, res) => {
    const auth = String(req.headers["authorization"] ?? "");
    const decoded = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (password !== opts.password) {
      seen.rejected += 1;
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end();
      return;
    }
    seen.authorized += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    const child = spawn(opts.gitPath ?? "/usr/bin/git", ["http-backend"], {
      env: {
        PATH: "/usr/bin:/bin",
        GIT_PROJECT_ROOT: opts.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: decoded.slice(0, decoded.indexOf(":")),
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(child.stdin);
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("close", () => {
      const buf = Buffer.concat(out);
      const split = buf.indexOf("\r\n\r\n");
      const head = buf.subarray(0, split).toString("utf8");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") status = Number.parseInt(v, 10);
        else if (k) headers[k] = v;
      }
      res.writeHead(status, headers).end(buf.subarray(split + 4));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}
