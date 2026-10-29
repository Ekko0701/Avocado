import { evidencePrefixOf, type GitHubSettings, type RemoteRepo } from "@qa/shared";
import { useState } from "react";
import { errorMessage } from "../lib/errors";

const full = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;

/**
 * 저장소 이름은 사용자마다 다를 수 있어 토큰으로 볼 수 있는 저장소 목록에서 고른다.
 * 워크스페이스를 고르면 그 주인(owner)이 조직이 되고, 증적 저장소는 같은 주인의 연도로 끝나는 저장소(…-2026)에서 고른다.
 * 앱은 접두사 + 올해로 증적 저장소를 찾는다(PLAN 9.4). 설정 화면과 설정 마법사가 함께 쓴다.
 */
export function GitHubRepoPicker(props: { github: GitHubSettings; tokenStored: boolean; onSaved: (github: GitHubSettings) => Promise<void> | void }) {
  const g = props.github;
  const year = new Date().getFullYear();
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [evidence, setEvidence] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setMessage(null);
    try {
      const list = await window.qa.remote.repos();
      setRepos(list);
      // 지금 설정과 같은 저장소가 목록에 있으면 미리 고른다
      const has = (owner: string | null, repo: string) => list.some((r) => r.owner === owner && r.repo === repo);
      setWorkspace(g.owner && has(g.owner, g.workspaceRepo) ? `${g.owner}/${g.workspaceRepo}` : "");
      setEvidence(g.owner && has(g.owner, `${g.evidenceRepoPrefix}${year}`) ? `${g.evidenceRepoPrefix}${year}` : "");
      if (list.length === 0) setMessage("이 토큰으로 볼 수 있는 저장소가 없습니다. 토큰의 저장소 선택을 확인합니다.");
    } catch (e) {
      setMessage(`저장소 목록을 불러오지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const chosen = repos?.find((r) => full(r) === workspace) ?? null;
  const owner = chosen?.owner ?? null;
  const sameOwner = repos?.filter((r) => r.owner === owner) ?? [];
  const evidenceOptions = sameOwner.filter((r) => evidencePrefixOf(r.repo) !== null);
  const evidenceInfo = evidence ? evidencePrefixOf(evidence) : null;
  const evidenceRepo = sameOwner.find((r) => r.repo === evidence) ?? null;

  async function save() {
    if (!chosen || !evidenceInfo) return;
    const next: GitHubSettings = { owner: chosen.owner, workspaceRepo: chosen.repo, evidenceRepoPrefix: evidenceInfo.prefix };
    try {
      await window.qa.settings.update({ github: next });
      setMessage("고른 저장소로 저장했습니다");
      await props.onSaved(next);
    } catch (e) {
      setMessage(`저장하지 못했습니다: ${errorMessage(e)}`);
    }
  }

  return (
    <div className="stack" data-testid="github-repo-picker">
      <div className="row">
        <button type="button" className="secondary" disabled={!props.tokenStored || loading} onClick={() => void load()}>
          {loading ? "불러오는 중" : repos ? "저장소 목록 다시 불러오기" : "저장소 목록 불러오기"}
        </button>
        {!props.tokenStored ? <small className="hint">GitHub 토큰을 먼저 저장합니다.</small> : null}
      </div>
      {repos && repos.length > 0 ? (
        <>
          <div className="grid">
            <label>
              워크스페이스(테스트 케이스·플로우)
              <select
                value={workspace}
                onChange={(e) => {
                  setWorkspace(e.target.value);
                  setEvidence("");
                }}
              >
                <option value="">선택</option>
                {repos.map((r) => (
                  <option key={full(r)} value={full(r)}>
                    {full(r)}
                    {r.canPush ? "" : " · 읽기 전용"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              증적(연도별)
              <select value={evidence} onChange={(e) => setEvidence(e.target.value)} disabled={!owner}>
                <option value="">선택</option>
                {evidenceOptions.map((r) => (
                  <option key={full(r)} value={r.repo}>
                    {full(r)}
                    {r.canPush ? "" : " · 읽기 전용"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {chosen && !chosen.canPush ? <p className="warning">이 토큰으로는 워크스페이스에 쓸 수 없습니다(Contents·Pull requests 쓰기 권한).</p> : null}
          {owner && evidenceOptions.length === 0 ? (
            <p className="warning" data-testid="github-picker-no-evidence">
              {owner} 에 연도로 끝나는 증적 저장소(예: …-{year})가 없습니다. GitHub 에서 만들거나 이름을 바꾸고, 토큰에 그 저장소를 더한 뒤 다시 불러옵니다.
            </p>
          ) : null}
          {evidenceInfo && evidenceInfo.year !== year ? (
            <p className="warning">
              앱은 올해 저장소({evidenceInfo.prefix}
              {year})를 찾습니다. 고른 저장소는 {evidenceInfo.year}년 것입니다.
            </p>
          ) : null}
          {evidenceRepo && !evidenceRepo.canPush ? <p className="warning">이 토큰으로는 증적 저장소에 쓸 수 없습니다.</p> : null}
          <div className="row">
            <button type="button" disabled={!chosen || !evidenceInfo} onClick={() => void save()}>
              고른 저장소로 저장
            </button>
            {chosen && evidenceInfo ? (
              <small className="hint">
                조직 {chosen.owner} · 워크스페이스 {chosen.repo} · 증적 접두사 {evidenceInfo.prefix}
              </small>
            ) : null}
          </div>
        </>
      ) : null}
      {message ? (
        <small role="status" className="hint" data-testid="github-picker-message">
          {message}
        </small>
      ) : null}
    </div>
  );
}
