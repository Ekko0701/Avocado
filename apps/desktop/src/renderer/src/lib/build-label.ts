import type { Build } from "@qa/shared";

const SOURCE_TEXT: Record<Build["source"], string> = { file: "파일로 등록", script: "빌드 스크립트", project: "프로젝트 빌드" };

/** 빌드가 어디서 왔는지: 프로젝트 빌드는 "스킴 · 구성", 그 밖은 등록 방법. 커밋을 알면 앞 7자를 붙인다 */
export function buildOrigin(b: Build): string {
  return `${b.label ?? SOURCE_TEXT[b.source]}${b.commit ? ` · ${b.commit.slice(0, 7)}` : ""}`;
}

/** 만든 시각을 짧게: "11. 9. 15:20" */
export function buildTime(b: Build): string {
  return new Date(b.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * 고르는 목록에 보이는 빌드 이름: 버전(빌드 번호) · 만든 시각 · 어디서 왔는지.
 * 같은 앱은 버전·빌드 번호가 같은 일이 흔해서(같은 코드를 스킴만 바꿔 빌드) 시각과 스킴·구성으로 구분한다.
 * 목록이 좁아 뒤가 잘려도 구분되게 짧은 것을 앞에 둔다. 앱 ID 는 앱을 이미 고른 자리라 빼고, 빌드 화면에서 본다
 */
export function buildLabel(b: Build): string {
  return `${b.version} (${b.buildNumber}) · ${buildTime(b)} · ${buildOrigin(b)}`;
}
