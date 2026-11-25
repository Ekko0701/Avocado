import type { WorkspaceSourceKind } from "@qa/shared";

/**
 * 설정 마법사 단계(PLAN 11장, ADR 0036). 2단계 "저장 위치"의 GitHub 사용 체크가 4단계를 정한다:
 * 켜면 저장소를 고르고 받는 단계, 끄면 로컬 워크스페이스에 첫 앱을 등록하는 단계
 */
export function wizardSteps(source: WorkspaceSourceKind): string[] {
  return ["Claude 연결", "저장 위치", "환경 점검·도구", source === "local" ? "첫 앱" : "GitHub·워크스페이스", "QA 기기", "완료"];
}

/** 증적 폴더는 로컬 워크스페이스와 같은 앱 데이터 폴더에 있다(userData/evidence). 그 모양이 아니면 null */
export function evidenceLocation(workspaceLocation: string): string | null {
  const suffix = "/local-workspace";
  return workspaceLocation.endsWith(suffix) ? `${workspaceLocation.slice(0, -suffix.length)}/evidence` : null;
}
