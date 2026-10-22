/** maestro 콘솔 출력(표준 출력·오류) 해석 */

// eslint-disable-next-line no-control-regex -- ANSI 제어 문자를 지우기 위한 정규식
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Maestro 2.11.0 의 드라이버 시작 실패 예외(maestro-client.jar, maestro-ios-driver.jar 의 클래스 이름).
 * MaestroDriverStartupException 의 하위 클래스로 Android 의 AndroidDriverTimeoutException·AndroidInstrumentationSetupFailure 가 있다.
 */
const DRIVER_FAILURE = /\b(IOSDriverTimeoutException|IOSDeviceDriverSetupException|MaestroDriverStartupException|MaestroException\$DriverTimeout)\b/;

export function isDriverFailure(consoleText: string): boolean {
  return DRIVER_FAILURE.test(consoleText);
}

/** 스택 트레이스 첫 줄(`패키지.클래스: 메시지`)의 메시지. 없으면 null */
export function exceptionMessage(consoleText: string): string | null {
  for (const raw of stripAnsi(consoleText).split("\n")) {
    const m = /^\s*([\w.$]+(?:Exception|Error|Failure)[\w$]*): (.+)$/.exec(raw);
    if (m?.[2]) return m[2].trim();
  }
  return null;
}
