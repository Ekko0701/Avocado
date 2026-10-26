import type { UpdateStatus } from "@qa/shared";

/** 새 버전 확인·받기 결과를 화면끼리 알린다. 설정에서 확인하면 맨 위 배너가 바로 바뀐다 */
const EVENT = "avocado:update-status";

export function notifyUpdateStatus(status: UpdateStatus): void {
  window.dispatchEvent(new CustomEvent<UpdateStatus>(EVENT, { detail: status }));
}

export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<UpdateStatus>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
