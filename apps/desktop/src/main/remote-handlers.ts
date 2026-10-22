import type { IpcHandlers, Settings } from "@qa/shared";
import type { RemoteProvider } from "@qa/remote";

/** 설정의 조직·저장소 이름으로 연결을 확인한다(T-109). 증적 저장소는 올해 것(PLAN 9.4) */
export function createRemoteHandlers(remote: RemoteProvider, settings: () => Settings, now: () => Date = () => new Date()): Pick<IpcHandlers, "remote:verify" | "remote:repos"> {
  return {
    "remote:verify": () => {
      const g = settings().github;
      if (!g.owner) throw new Error("GitHub 조직 이름을 먼저 설정한다");
      return remote.verify([
        { owner: g.owner, repo: g.workspaceRepo },
        { owner: g.owner, repo: `${g.evidenceRepoPrefix}${now().getFullYear()}` },
      ]);
    },
    // 사용자마다 저장소 이름이 다를 수 있어 토큰으로 볼 수 있는 목록에서 고르게 한다
    "remote:repos": () => remote.listRepos(),
  };
}
