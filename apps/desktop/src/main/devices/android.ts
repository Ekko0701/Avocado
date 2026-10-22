/** adb·emulator 출력 해석 (순수 함수). */

/** 설정 언어(ko_KR) → Android 로캘(ko-KR) */
export function androidLocale(locale: string): string {
  return locale.replace("_", "-");
}

/** `adb devices` 출력에서 실행 중(device 상태)인 에뮬레이터 serial 만 뽑는다. */
export function parseEmulatorSerials(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial as string);
}

export function parseAvdList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
}

/** QA 용 AVD 를 고른다: 지정한 이름 → qa_ 로 시작하는 첫 AVD → 첫 AVD */
export function chooseAvd(avds: string[], requested?: string): string | null {
  if (requested) return avds.includes(requested) ? requested : null;
  return avds.find((a) => a.startsWith("qa_")) ?? avds[0] ?? null;
}
