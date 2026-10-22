/** IPC 오류 메시지에서 Electron 이 붙이는 접두어를 떼어 사람이 읽을 부분만 남긴다. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}
