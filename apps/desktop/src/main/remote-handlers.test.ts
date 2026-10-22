import { DEFAULT_SETTINGS, type Settings } from "@qa/shared";
import type { RemoteProvider, RepoRef } from "@qa/remote";
import { describe, expect, it } from "vitest";
import { createRemoteHandlers } from "./remote-handlers";

describe("GitHub 연결 확인 핸들러", () => {
  const seen: RepoRef[][] = [];
  const remote = { verify: (repos: RepoRef[]) => (seen.push(repos), Promise.resolve({ login: "qa-bot", repos: [] })) } as unknown as RemoteProvider;
  const at = () => new Date("2026-10-22T00:00:00+09:00");

  it("조직이 없으면 묻지 않고 실패한다", () => {
    const h = createRemoteHandlers(remote, () => DEFAULT_SETTINGS, at);
    expect(() => h["remote:verify"](undefined)).toThrow(/조직 이름/);
    expect(seen).toEqual([]);
  });

  it("워크스페이스와 올해 증적 저장소를 확인한다", async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, github: { owner: "acme", workspaceRepo: "qa-workspace", evidenceRepoPrefix: "qa-evidence-", appRepo: "qa-tool" } };
    await createRemoteHandlers(remote, () => settings, at)["remote:verify"](undefined);
    expect(seen.at(-1)).toEqual([
      { owner: "acme", repo: "qa-workspace" },
      { owner: "acme", repo: "qa-evidence-2026" },
    ]);
  });
});
