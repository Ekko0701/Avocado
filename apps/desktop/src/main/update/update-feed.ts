import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Squirrel.Mac 이 받아 갈 피드(ADR 0027). 확인을 마친 .zip 하나만 내준다 */
export interface UpdateFeed {
  /** autoUpdater.setFeedURL 에 넘긴다. 응답은 {"url": <zip 주소>} (Squirrel.Mac 기본 서버 형식) */
  url: string;
  close(): Promise<void>;
}

/**
 * 127.0.0.1 의 빈 포트에 피드를 연다. 경로에 임의 토큰을 넣어 다른 프로세스가 짐작해 받아 가지 못하게 하고,
 * 준비가 끝나면 바로 닫는다. 파일은 읽기만 한다
 */
export async function startUpdateFeed(zipFile: string): Promise<UpdateFeed> {
  const size = statSync(zipFile).size;
  const token = randomBytes(16).toString("hex");
  let base = "";
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === `/${token}/feed`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: `${base}/${token}/update.zip` }));
      return;
    }
    if (req.method === "GET" && req.url === `/${token}/update.zip`) {
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": size });
      createReadStream(zipFile)
        .on("error", (error) => res.destroy(error))
        .pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/${token}/feed`,
    close: () =>
      new Promise<void>((resolve) => {
        // Squirrel 이 연결을 열어 둘 수 있어 끊고 닫는다
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
