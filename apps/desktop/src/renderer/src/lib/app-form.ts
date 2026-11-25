import type { AppTargetEdit, SaveAppSettingsInput } from "@qa/shared";

export type TargetId = AppTargetEdit["target"];
export const TARGETS: { id: TargetId; label: string; hint: string }[] = [
  { id: "ios", label: "iOS", hint: "번들 ID (예: com.example.app)" },
  { id: "android", label: "Android", hint: "패키지 이름 (예: com.example.app)" },
  { id: "flutter-ios", label: "Flutter iOS", hint: "번들 ID" },
  { id: "flutter-android", label: "Flutter Android", hint: "패키지 이름" },
];
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOCALE = /^[a-z]{2}_[A-Z]{2}$/;
const ROLE = /^[a-z][a-z0-9-]{0,39}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 타깃 한 줄: 쓰는지와 앱 ID */
export interface TargetChoice {
  on: boolean;
  appId: string;
}
export type TargetChoices<T extends TargetChoice = TargetChoice> = Record<TargetId, T>;

export interface RoleRow {
  role: string;
  description: string;
  /** 쉼표로 구분한 키 이름 */
  keys: string;
}

export const splitKeys = (keys: string) =>
  keys
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

/** 입력하는 동안 보이는 앱 설정 형식 문제(저장할 때 main 이 다시 검사한다) */
export function appFormProblems(form: { name: string; locale: string; targets: TargetChoices; roles: RoleRow[] }, newApp: { id: string; taken: boolean } | null): string[] {
  const out: string[] = [];
  if (newApp && !APP_ID.test(newApp.id)) out.push("폴더·CLI 이름(앱 id)은 영문 소문자·숫자·하이픈만 씁니다");
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
 * 앱 이름에서 앱 id(폴더·테스트 케이스·CLI 이름)를 만든다. "Demo Dev" → "demo-dev", "Café" → "cafe".
 * 영문으로 바꿀 수 없는 글자(한글 등)가 있으면 일부만 남겨 엉뚱한 id 가 되지 않게 "" 를 돌려준다. 그때는 사람이 직접 쓴다
 */
export function appIdFromName(name: string): string {
  const latin = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  if ([...latin].some((c) => c.charCodeAt(0) > 0x7f)) return "";
  return latin
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** 이름과 앱 id. idEdited 면 사람이 id 를 고쳤으니 이름을 바꿔도 id 를 다시 만들지 않는다 */
export interface AppNameValue {
  name: string;
  id: string;
  idEdited: boolean;
}

export function withName(value: AppNameValue, name: string): AppNameValue {
  return { ...value, name, id: value.idEdited ? value.id : appIdFromName(name) };
}

/** 로컬 워크스페이스의 첫 앱 등록(마법사의 첫 앱 단계와 빈 워크스페이스 화면). 언어와 계정 역할은 나중에 앱 설정에서 정한다 */
export interface FirstAppDraft extends AppNameValue {
  targets: TargetChoices;
}

export function emptyFirstApp(): FirstAppDraft {
  const targets = Object.fromEntries(TARGETS.map((t) => [t.id, { on: t.id === "ios", appId: "" }])) as TargetChoices;
  return { id: "", name: "", idEdited: false, targets };
}

export function firstAppProblems(draft: FirstAppDraft, existing: readonly string[]): string[] {
  const id = draft.id.trim();
  return appFormProblems({ name: draft.name, locale: "", targets: draft.targets, roles: [] }, { id, taken: existing.includes(id) });
}

export function firstAppInput(draft: FirstAppDraft): SaveAppSettingsInput {
  return {
    app: draft.id.trim(),
    create: true,
    name: draft.name.trim(),
    locale: null,
    targets: TARGETS.filter((t) => draft.targets[t.id].on).map((t) => ({ target: t.id, appId: draft.targets[t.id].appId.trim() })),
    roles: [],
    summary: "add app",
  };
}

export interface SubflowRow {
  target: TargetId;
  label: string;
  path: string;
  hint: string;
}

/** 로컬 워크스페이스에서 타깃을 더하면 main 이 만드는 공통 서브플로우 기본 파일(ADR 0036 결정 8). 고른 타깃마다 셋이다 */
export function defaultSubflowRows(targets: TargetChoices): SubflowRow[] {
  return TARGETS.filter((t) => targets[t.id].on).flatMap((t) => {
    const android = t.id === "android" || t.id === "flutter-android";
    return [
      {
        target: t.id,
        label: t.label,
        path: "common/launch-clean.yaml",
        hint: android ? "앱 데이터를 지우고 앱을 띄웁니다. 플로우 첫 줄이 부릅니다" : "앱 데이터와 키체인을 지우고 앱을 띄웁니다. 플로우 첫 줄이 부릅니다. 시뮬레이터용입니다",
      },
      { target: t.id, label: t.label, path: "common/dismiss-system-prompts.yaml", hint: android ? "보이면 닫는 권한 팝업(허용, 앱 사용 중에만 허용)" : "보이면 닫는 시스템 팝업(허용, 지금 안 함)" },
      { target: t.id, label: t.label, path: "common/close-keyboard.yaml", hint: "키보드를 닫습니다" },
    ];
  });
}
