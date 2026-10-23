/**
 * 업데이트 파일을 열어도 되는 서명자(Apple Developer ID 팀 ID, 10자). D12(2026-10-22, ADR 0021).
 * spctl(공증) 통과만으로는 아무 Developer ID 로 서명한 파일도 받아들이므로, 이 팀의 서명인지도 본다(PLAN 10.4).
 * null 이면 어떤 업데이트도 자동으로 열지 않는다.
 */
export const UPDATE_SIGNER_TEAM_ID: string | null = "34JS69S5XZ";

/**
 * 새 버전을 확인하는 배포 저장소(공개). 워크스페이스·증적 저장소의 GitHub 조직과 상관없이 모든 사용자가 여기서 받는다(ADR 0020, 0024).
 * 공개 저장소라 GitHub 토큰이 없어도 확인한다
 */
export const UPDATE_RELEASE_REPO = { owner: "Ekko0701", repo: "Avocado" } as const;
