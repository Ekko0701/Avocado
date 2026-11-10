import type { RequestReviewResult, WorkspaceStatus } from "@qa/shared";
import { useState } from "react";
import { errorMessage } from "../lib/errors";
import { notifyWorkspaceChanged } from "../lib/workspace-events";

const LAYOUT_BRANCH = /^qa\/[^/]+\/workspace\//;

/**
 * 워크스페이스 폴더 구조 바꾸기(ADR 0032). 예전 구조(testcases/<앱>, flows/<앱>)일 때 새 구조(apps/<앱>/…)로 옮기는 커밋을 만들고,
 * 그 작업 브랜치에 있을 때 PR 을 올린다. 그 밖에는 아무것도 그리지 않는다.
 */
export function LayoutMigration(props: { status: WorkspaceStatus; onChanged: (status: WorkspaceStatus) => void }) {
  const { status } = props;
  const [busy, setBusy] = useState<"migrate" | "pr" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pr, setPr] = useState<RequestReviewResult | null>(null);
  const onLayoutBranch = status.layout === 2 && LAYOUT_BRANCH.test(status.branch ?? "");
  if (!status.connected || (status.layout !== 1 && !onLayoutBranch)) return null;

  async function migrate() {
    setBusy("migrate");
    setMessage(null);
    try {
      const r = await window.qa.workspace.migrateLayout();
      props.onChanged(r.status);
      notifyWorkspaceChanged();
      setMessage(`새 폴더 구조로 옮겨 ${r.branch} 에 커밋했습니다(${r.commit}). PR 을 올립니다.`);
    } catch (e) {
      setMessage(`폴더 구조 바꾸기 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  }

  async function requestReview() {
    if (!status.branch) return;
    setBusy("pr");
    setMessage(null);
    try {
      setPr(
        await window.qa.workspace.requestReview({
          title: "워크스페이스 폴더를 앱별로 모은다 (schemaVersion 2)",
          body: "testcases/<앱> 과 flows/<앱> 을 apps/<앱>/ 아래로 옮겼습니다. 파일 내용은 바꾸지 않았습니다.\n\n머지하기 전에 팀원이 모두 새 구조를 읽는 Avocado 버전으로 업데이트했는지 확인합니다.",
          branch: status.branch,
        }),
      );
    } catch (e) {
      setMessage(`PR 작성 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack" aria-label="폴더 구조" data-testid="layout-migration">
      <h2>폴더 구조</h2>
      {status.layout === 1 ? (
        <>
          <p className="hint">
            지금은 예전 폴더 구조입니다(<code>testcases/&lt;앱&gt;</code>, <code>flows/&lt;앱&gt;</code>). 새 구조는 한 앱의 설정·테스트 케이스·플로우를 <code>apps/&lt;앱&gt;/</code> 아래에 모읍니다. 파일
            내용과 변경 내역은 그대로입니다.
          </p>
          <ul className="hint">
            <li>팀원이 모두 이 버전 이상으로 업데이트한 뒤에 바꿉니다. 예전 버전의 Avocado 는 새 구조를 읽지 못합니다.</li>
            <li>작업 브랜치에 한 커밋으로 만들고 PR 로 올립니다. 머지한 뒤 main 에서 동기화하면 새 구조가 됩니다.</li>
            <li>main 에 아직 없는 작업 브랜치가 있으면 먼저 머지합니다. 폴더를 옮기면 그 브랜치와 충돌합니다.</li>
          </ul>
          <div className="row">
            {confirm ? (
              <>
                <button type="button" disabled={busy !== null} onClick={() => void migrate()}>
                  {busy === "migrate" ? "옮기는 중" : "정말 바꾸기"}
                </button>
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirm(false)}>
                  취소
                </button>
              </>
            ) : (
              <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirm(true)}>
                새 폴더 구조로 바꾸기
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            폴더 구조를 바꾼 커밋이 <code>{status.branch}</code> 에 있습니다. PR 을 올리고 머지한 뒤, 테스트 케이스 화면에서 main 으로 옮겨 동기화합니다.
          </p>
          <div className="row">
            <button type="button" disabled={busy !== null} onClick={() => void requestReview()}>
              {busy === "pr" ? "올리는 중" : "PR 작성"}
            </button>
          </div>
        </>
      )}
      {message ? (
        <p role="status" data-testid="layout-migration-message">
          {message}
        </p>
      ) : null}
      {pr ? (
        <p role="status" className="ok-text" data-testid="layout-migration-pr">
          {pr.existing ? `열린 PR #${pr.number} 에 새 커밋을 올렸습니다: ` : `PR #${pr.number} 을 만들었습니다(${pr.branch}): `}
          <code>{pr.url}</code>
        </p>
      ) : null}
    </section>
  );
}
