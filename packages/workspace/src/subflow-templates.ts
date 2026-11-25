import type { Target } from "./schemas";

/**
 * 로컬 워크스페이스에서 앱에 타깃을 더할 때 만드는 공통 서브플로우 기본 파일(ADR 0036 결정 8).
 * 플로우 만들기가 첫 줄에서 부를 서브플로우가 있어야 한다. 앱마다 다른 온보딩·팝업은 사람이 앱에서 고친다.
 * 서브플로우 규약(lintSubflow)과 Maestro 문법을 통과해야 한다(테스트로 확인한다).
 */
export interface SubflowTemplate {
  /** common/ 바로 아래 파일 이름 */
  name: string;
  text: string;
}

// clearState 와 clearKeychain 은 iPhone 실기기에서 재생할 수 없다(ADR 0034). 이 기본 파일로 시작하는 iOS 플로우는 시뮬레이터용이다
const IOS_LAUNCH_CLEAN = `# 로그인 정보까지 지우고 앱을 새로 띄운다. 토큰은 키체인에 있어 clearState 만으로는 남는다(iOS 는 앱 데이터와 키체인을 따로 지운다).
# clearKeychain 은 시뮬레이터 전체 키체인을 지운다. QA 전용 시뮬레이터에서만 쓴다. iPhone 실기기에서는 재생할 수 없다.
# 첫 화면 대기와 첫 실행 팝업·온보딩을 닫는 스텝은 앱에 맞게 아래에 더한다.
appId: \${APP_ID}
---
- clearKeychain
- launchApp:
    clearState: true
`;

const ANDROID_LAUNCH_CLEAN = `# 앱 상태를 지우고 새로 띄운다. 첫 화면 대기와 첫 실행 팝업·온보딩을 닫는 스텝은 앱에 맞게 아래에 더한다.
appId: \${APP_ID}
---
- launchApp:
    clearState: true
`;

const IOS_DISMISS = `# 보이면 처리하는 iOS 시스템 팝업. 저절로 사라지기도 해서 모두 선택 사항이다.
appId: \${APP_ID}
---
- tapOn:
    text: "허용"
    optional: true
- tapOn:
    text: "지금 안 함"
    optional: true
`;

const ANDROID_DISMISS = `# 보이면 처리하는 Android 권한 팝업. 저절로 사라지기도 해서 모두 선택 사항이다.
appId: \${APP_ID}
---
- tapOn:
    text: "허용"
    optional: true
- tapOn:
    text: "앱 사용 중에만 허용"
    optional: true
`;

const CLOSE_KEYBOARD = `# 키보드를 닫는다. 앱이 키보드 위에 "완료" 막대를 붙이면 hideKeyboard 대신 그 버튼을 누르게 고친다.
appId: \${APP_ID}
---
- hideKeyboard
`;

/** 타깃의 기본 서브플로우. flutter-* 는 같은 플랫폼 것을 쓴다 */
export function defaultSubflows(target: Target): SubflowTemplate[] {
  const android = target === "android" || target === "flutter-android";
  return [
    { name: "launch-clean.yaml", text: android ? ANDROID_LAUNCH_CLEAN : IOS_LAUNCH_CLEAN },
    { name: "dismiss-system-prompts.yaml", text: android ? ANDROID_DISMISS : IOS_DISMISS },
    { name: "close-keyboard.yaml", text: CLOSE_KEYBOARD },
  ];
}
