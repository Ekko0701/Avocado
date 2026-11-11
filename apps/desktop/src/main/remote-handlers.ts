import { evidenceRepoOf, type IpcHandlers, type Settings } from "@qa/shared";
import type { RemoteProvider } from "@qa/remote";

/** 설정의 조직·저장소 이름으로 연결을 확인한다(T-109). 증적 저장소는 이름을 그대로 정했으면 그 저장소, 아니면 올해 것(PLAN 9.4, ADR 0033) */
export function createRemoteHandlers(remote: RemoteProvider, settings: () => Settings, now: () => Date = () => new Date()): Pick<IpcHandlers, "remote:verify" | "remote:repos"> {
  return {
    "remote:verify": () => {
      const g = settings().github;
      const evidence = evidenceRepoOf(g, now().getFullYear());
      if (!g.owner || !evidence) throw new Error("GitHub 조직 이름을 먼저 설정한다");
      return remote.verify([{ owner: g.owner, repo: g.workspaceRepo }, evidence]);
    },
    // 사용자마다 저장소 이름이 다를 수 있어 토큰으로 볼 수 있는 목록에서 고르게 한다
    "remote:repos": () => remote.listRepos(),
  };
}
