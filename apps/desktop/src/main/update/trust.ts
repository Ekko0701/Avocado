/**
 * 업데이트 파일을 열어도 되는 서명자(Apple Developer ID 팀 ID, 10자). D12(2026-10-22, ADR 0021).
 * spctl(공증) 통과만으로는 아무 Developer ID 로 서명한 파일도 받아들이므로, 이 팀의 서명인지도 본다(PLAN 10.4).
 * null 이면 어떤 업데이트도 자동으로 열지 않는다.
 */
export const UPDATE_SIGNER_TEAM_ID: string | null = "34JS69S5XZ";
