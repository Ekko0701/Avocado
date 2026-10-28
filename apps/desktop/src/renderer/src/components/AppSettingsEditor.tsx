import type { AccountRoleEdit, AppSettingsDoc, AppTargetEdit, RequestReviewResult } from "@qa/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/errors";
import { notifyWorkspaceChanged } from "../lib/workspace-events";

type TargetId = AppTargetEdit["target"];
const TARGETS: { id: TargetId; label: string; hint: string }[] = [
  { id: "ios", label: "iOS", hint: "번들 ID (예: com.example.app)" },
  { id: "android", label: "Android", hint: "패키지 이름 (예: com.example.app)" },
  { id: "flutter-ios", label: "Flutter iOS", hint: "번들 ID" },
  { id: "flutter-android", label: "Flutter Android", hint: "패키지 이름" },
];
const NEW_APP = "__new__";
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOCALE = /^[a-z]{2}_[A-Z]{2}$/;
const ROLE = /^[a-z][a-z0-9-]{0,39}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

interface RoleRow {
  role: string;
  description: string;
  /** 쉼표로 구분한 키 이름 */
  keys: string;
}
interface Form {
  name: string;
  locale: string;
  /** scheme·configuration: 프로젝트로 빌드할 때 팀 기본값(iOS 만 쓴다, ADR 0025) */
  targets: Record<TargetId, TargetForm>;
  roles: RoleRow[];
}
interface TargetForm {
  on: boolean;
  appId: string;
  scheme: string;
  configuration: string;
}

const splitKeys = (keys: string) =>
  keys
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

function toForm(doc: AppSettingsDoc | null): Form {
  const targets = Object.fromEntries(TARGETS.map((t) => [t.id, { on: false, appId: "", scheme: "", configuration: "" }])) as Record<TargetId, TargetForm>;
  for (const t of doc?.targets ?? []) targets[t.target] = { on: true, appId: t.appId, scheme: t.scheme ?? "", configuration: t.configuration ?? "" };
  return {
    name: doc?.name ?? "",
    locale: doc?.locale ?? "",
    targets,
    roles: (doc?.roles ?? []).map((r: AccountRoleEdit) => ({ role: r.role, description: r.description, keys: r.keys.join(", ") })),
  };
}

/** 입력하는 동안 보이는 형식 문제(저장할 때 main 이 다시 검사한다) */
function formProblems(form: Form, newApp: { id: string; taken: boolean } | null): string[] {
  const out: string[] = [];
  if (newApp && !APP_ID.test(newApp.id)) out.push("앱 ID 는 영문 소문자·숫자·하이픈만 씁니다");
  if (newApp?.taken) out.push(`이미 있는 앱입니다: ${newApp.id}`);
  if (!form.name.trim()) out.push("앱 이름을 씁니다");
  if (form.locale.trim() && !LOCALE.test(form.locale.trim())) out.push("언어는 ko_KR 형식으로 쓰거나 비웁니다");
  const on = TARGETS.filter((t) => form.targets[t.id].on);
  if (on.length === 0) out.push("타깃을 하나 이상 고릅니다");
  for (const t of on) {
    const appId = form.targets[t.id].appId.trim();
    if (!appId || /\s/.test(appId)) out.push(`${t.label} 앱 ID 를 공백 없이 씁니다`);
  }
  form.roles.forEach((row, i) => {
    const role = row.role.trim();
    const keys = splitKeys(row.keys);
    const bad = keys.filter((k) => !KEY.test(k));
    if (!ROLE.test(role)) out.push(`계정 역할 ${i + 1}: 역할 이름은 영문 소문자로 시작하고 소문자·숫자·하이픈만 씁니다`);
    else if (form.roles.filter((r) => r.role.trim() === role).length > 1) out.push(`계정 역할 ${i + 1}: 같은 역할 이름이 두 번 있습니다(${role})`);
    if (keys.length === 0) out.push(`계정 역할 ${i + 1}: 키 이름을 하나 이상 씁니다`);
    else if (bad.length > 0) out.push(`계정 역할 ${i + 1}: 키 이름은 영문 대문자·숫자·밑줄만 씁니다(${bad.join(", ")})`);
  });
  return out;
}

/**
 * 앱 설정(apps/<앱>/app.yaml·accounts.yaml): 이름·언어·타깃별 앱 ID 와 계정 역할. 새 앱도 여기서 만든다.
 * 저장하면 그 앱의 앱 설정 작업 브랜치에 커밋하고, PR 작성으로 PR 을 만든다. 계정 값은 설정 → 테스트 계정 값에서 넣는다.
 * TC·플로우가 쓰는 타깃·역할·키는 main 이 지우지 못하게 막는다.
 */
export function AppSettingsEditor(props: { apps: { app: string; name: string }[] }) {
  const [selected, setSelected] = useState(props.apps[0]?.app ?? NEW_APP);
  const [newId, setNewId] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [saved, setSaved] = useState<{ app: string; branch: string } | null>(null);
  const [pr, setPr] = useState<RequestReviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const creating = selected === NEW_APP;
  const app = creating ? newId.trim() : selected;

  const load = useCallback(async (target: string) => {
    const doc = await window.qa.workspace.readApp({ app: target });
    setForm(toForm(doc));
    setSource(doc.branch);
  }, []);

  useEffect(() => {
    setForm(null);
    setSource(null);
    setPr(null);
    if (selected === NEW_APP) {
      setForm(toForm(null));
      return;
    }
    load(selected).catch((e: unknown) => setMessage(`앱 설정을 읽지 못했습니다: ${errorMessage(e)}`));
  }, [selected, load]);

  const problems = form ? formProblems(form, creating ? { id: app, taken: props.apps.some((a) => a.app === app) } : null) : [];
  const canSave = form !== null && !busy && summary.trim() !== "" && problems.length === 0;

  function patch(next: Partial<Form>) {
    setForm((prev) => (prev ? { ...prev, ...next } : prev));
  }
  function patchTarget(id: TargetId, next: Partial<TargetForm>) {
    setForm((prev) => (prev ? { ...prev, targets: { ...prev.targets, [id]: { ...prev.targets[id], ...next } } } : prev));
  }
  function patchRole(index: number, next: Partial<RoleRow>) {
    setForm((prev) => (prev ? { ...prev, roles: prev.roles.map((r, i) => (i === index ? { ...r, ...next } : r)) } : prev));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    setPr(null);
    try {
      const r = await window.qa.workspace.saveApp({
        app,
        create: creating,
        name: form.name.trim(),
        locale: form.locale.trim() || null,
        targets: TARGETS.filter((t) => form.targets[t.id].on).map((t) => ({
          target: t.id,
          appId: form.targets[t.id].appId.trim(),
          ...(t.id === "ios" ? { scheme: form.targets.ios.scheme.trim() || null, configuration: form.targets.ios.configuration.trim() || null } : {}),
        })),
        roles: form.roles.map((row) => ({ role: row.role.trim(), description: row.description.trim(), keys: splitKeys(row.keys) })),
        summary: summary.trim(),
      });
      setSaved({ app, branch: r.branch });
      setMessage(
        `${r.branch} 에 커밋했습니다(${r.commit}).${creating ? " 새 앱을 워크스페이스에 더했습니다." : ""} 계정 값은 설정 → 테스트 계정 값에서 넣습니다.`,
      );
      notifyWorkspaceChanged();
      if (creating) {
        setNewId("");
        setSelected(app);
      } else {
        await load(app);
      }
    } catch (e) {
      setMessage(`저장 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    if (!saved) return;
    setBusy(true);
    setMessage(null);
    try {
      setPr(
        await window.qa.workspace.requestReview({
          title: `app: ${saved.app} ${summary.trim()}`,
          body: `## 변경\n\n- 앱: ${saved.app}\n- 요약: ${summary.trim()}\n- 앱 설정(app.yaml·accounts.yaml)만 바꿉니다. 계정 값은 각자 설정에서 넣습니다.\n`,
          branch: saved.branch,
        }),
      );
    } catch (e) {
      setMessage(`PR 작성 실패: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" aria-label="앱 설정" data-testid="app-settings" onSubmit={(e) => void save(e)}>
      <h2>앱 설정</h2>
      <p className="hint">
        테스트할 앱의 이름·언어·타깃별 앱 ID 와, TC 가 고르는 계정 역할입니다(apps/&lt;앱&gt;/app.yaml, accounts.yaml). 저장하면 그 앱의 앱 설정 작업 브랜치에
        커밋하고, PR 작성을 누르면 PR 을 만듭니다. 계정 값은 여기서 넣지 않고 설정 → 테스트 계정 값에서 넣습니다. TC·플로우가 쓰는 타깃·역할·키는 지울 수 없습니다.
      </p>
      <div className="row">
        <label>
          앱
          <select aria-label="설정할 앱" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {props.apps.map((a) => (
              <option key={a.app} value={a.app}>
                {a.name} ({a.app})
              </option>
            ))}
            {props.apps.some((a) => a.app === selected) || selected === NEW_APP ? null : <option value={selected}>{selected}</option>}
            <option value={NEW_APP}>＋ 새 앱</option>
          </select>
        </label>
        {creating ? (
          <label className="grow">
            새 앱 ID
            <input aria-label="새 앱 ID" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="예: my-app (영문 소문자·숫자·하이픈, 나중에 바꿀 수 없음)" />
          </label>
        ) : null}
      </div>
      {source ? (
        <p className="hint" data-testid="app-settings-source">
          아직 머지되지 않은 작업 브랜치 <code>{source}</code> 의 내용입니다.
        </p>
      ) : null}

      {form === null ? (
        <p className="hint">불러오는 중</p>
      ) : (
        <>
          <div className="grid">
            <label>
              이름
              <input aria-label="앱 이름" value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="예: My App" />
            </label>
            <label>
              언어
              <input aria-label="앱 언어" value={form.locale} onChange={(e) => patch({ locale: e.target.value })} placeholder="예: ko_KR (비우면 워크스페이스 기본값)" />
            </label>
          </div>

          <fieldset className="targets">
            <legend>타깃과 앱 ID</legend>
            {TARGETS.map((t) => (
              <div key={t.id} className="target-row" data-testid={`app-target-${t.id}`}>
                <label>
                  <input type="checkbox" aria-label={`${t.label} 사용`} checked={form.targets[t.id].on} onChange={(e) => patchTarget(t.id, { on: e.target.checked })} />
                  {t.label}
                </label>
                <input aria-label={`${t.label} 앱 ID`} value={form.targets[t.id].appId} disabled={!form.targets[t.id].on} onChange={(e) => patchTarget(t.id, { appId: e.target.value })} placeholder={t.hint} />
              </div>
            ))}
            <div className="target-row" data-testid="app-target-ios-build">
              <span className="hint">iOS 빌드 기본값</span>
              <div className="row">
                <input aria-label="iOS 스킴" value={form.targets.ios.scheme} disabled={!form.targets.ios.on} onChange={(e) => patchTarget("ios", { scheme: e.target.value })} placeholder="스킴(빌드 화면의 프로젝트 빌드)" />
                <input aria-label="iOS 구성" value={form.targets.ios.configuration} disabled={!form.targets.ios.on} onChange={(e) => patchTarget("ios", { configuration: e.target.value })} placeholder="구성(예: Debug)" />
              </div>
            </div>
          </fieldset>

          <h3>계정 역할</h3>
          {form.roles.length === 0 ? <p className="hint">계정이 필요 없는 앱이면 비워 둡니다.</p> : null}
          {form.roles.length > 0 ? (
            <table className="matrix editable">
              <thead>
                <tr>
                  <th>역할</th>
                  <th>설명</th>
                  <th>키 이름(쉼표로 구분)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {form.roles.map((row, i) => (
                  <tr key={i} data-testid={`account-role-${i}`}>
                    <td>
                      <input aria-label={`역할 이름 ${i + 1}`} value={row.role} placeholder="예: member" onChange={(e) => patchRole(i, { role: e.target.value })} />
                    </td>
                    <td>
                      <input aria-label={`설명 ${i + 1}`} value={row.description} placeholder="예: 미리 만든 로그인 계정" onChange={(e) => patchRole(i, { description: e.target.value })} />
                    </td>
                    <td>
                      <input aria-label={`키 ${i + 1}`} value={row.keys} placeholder="예: APP_MEMBER_EMAIL, APP_MEMBER_PASSWORD" onChange={(e) => patchRole(i, { keys: e.target.value })} />
                    </td>
                    <td>
                      <button type="button" className="secondary" aria-label={`역할 ${i + 1} 삭제`} onClick={() => patch({ roles: form.roles.filter((_, n) => n !== i) })}>
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="row">
            <button type="button" className="secondary" disabled={busy} onClick={() => patch({ roles: [...form.roles, { role: "", description: "", keys: "" }] })}>
              역할 추가
            </button>
          </div>

          {problems.length > 0 ? (
            <ul className="checks" data-testid="app-settings-problems">
              {problems.map((p) => (
                <li key={p} className="error">
                  {p}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row">
            <label className="grow">
              변경 요약
              <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={80} placeholder="예: add android target" />
            </label>
            <button type="submit" disabled={!canSave}>
              {busy ? "저장 중" : "저장(커밋)"}
            </button>
            {saved ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void review()}>
                PR 작성
              </button>
            ) : null}
          </div>
        </>
      )}
      {message ? (
        <p role="status" data-testid="app-settings-message">
          {message}
        </p>
      ) : null}
      {pr ? (
        <p role="status" className="ok-text" data-testid="app-settings-pr">
          {pr.existing ? `열린 PR #${pr.number} 에 새 커밋을 올렸습니다: ` : `PR #${pr.number} 을 만들었습니다(${pr.branch}): `}
          <code>{pr.url}</code>
        </p>
      ) : null}
    </form>
  );
}
