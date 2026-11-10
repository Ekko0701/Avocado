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

/** `adb devices -l` 의 실기기 한 줄 */
export interface AdbPhysicalDevice {
  serial: string;
  /** adb 상태: device(사용 가능), unauthorized(폰에서 USB 디버깅 허용 전), offline 등 */
  state: string;
  /** model:Pixel_8 → "Pixel 8". 허용 전이면 null */
  model: string | null;
}

/** `adb devices -l` 출력에서 에뮬레이터가 아닌 기기(USB·무선 디버깅으로 연결한 폰)를 뽑는다 (ADR 0030). */
export function parsePhysicalDevices(stdout: string): AdbPhysicalDevice[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices") && !line.startsWith("*"))
    .map((line) => line.split(/\s+/))
    .filter(([serial, state]) => serial && state && !serial.startsWith("emulator-"))
    .map(([serial, state, ...rest]) => {
      const model = rest.find((f) => f.startsWith("model:"))?.slice("model:".length).replaceAll("_", " ") ?? null;
      return { serial: serial as string, state: state as string, model: model || null };
    });
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
