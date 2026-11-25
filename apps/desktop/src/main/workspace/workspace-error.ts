/** 워크스페이스 작업이 거절되거나 실패했을 때. 메시지가 화면에 그대로 보인다 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
