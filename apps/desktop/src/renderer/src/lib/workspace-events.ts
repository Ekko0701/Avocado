/** 워크스페이스 상태(브랜치·커밋·동기화)가 바뀌었음을 화면끼리 알린다. 툴바와 각 화면이 다시 읽는다 */
const EVENT = "avocado:workspace-changed";

export function notifyWorkspaceChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onWorkspaceChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
