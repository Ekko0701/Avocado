import type { AgentMode } from "./budget";

/**
 * MCP 도구 허용 목록(PLAN 6.3). 목록에 없는 도구는 모델에게 아예 보이지 않는다.
 * 인자도 허용한 것만 받는다(모델이 파일 경로·환경 변수·클라우드 업로드를 넘기지 못하게).
 */
export interface ToolPolicy {
  /** 모델이 넘길 수 있는 인자(모두 문자열) */
  args: readonly string[];
  /** 이 인자는 작업에 배정된 기기 id 로 고정한다 */
  deviceArg?: string;
  /** 결과를 <screen_data> 로 감싼다 */
  screenData?: boolean;
  /** 앱이 계정 값을 env 로 넣는다(모델은 키 이름만 안다) */
  injectEnv?: boolean;
}

/**
 * maestro mcp (Maestro 2.11.0) 도구: list_devices, take_screenshot, run, inspect_screen, cheat_sheet,
 * open_maestro_viewer, list_cloud_devices, run_on_cloud, get_cloud_run_status, describe_cloud_run (2026-10-22 실제 서버에서 확인).
 * 클라우드 도구(앱·플로우를 외부로 올림)와 뷰어 링크는 어떤 모드에도 주지 않는다.
 * run 의 files·dir(로컬 파일 실행)·env·태그 인자도 막는다. 플로우 파일 검증·재생은 앱(RunService)이 한다(6.5).
 */
export const MAESTRO_POLICY: Readonly<Record<AgentMode, Readonly<Record<string, ToolPolicy>>>> = {
  author: {
    list_devices: { args: [] },
    inspect_screen: { args: ["device_id"], deviceArg: "device_id", screenData: true },
    take_screenshot: { args: ["device_id"], deviceArg: "device_id" },
    run: { args: ["device_id", "yaml"], deviceArg: "device_id", screenData: true, injectEnv: true },
    cheat_sheet: { args: [] },
  },
  // heal 은 증적 읽기 도구(앱 도구)로 한다. 재현용 기기 도구는 M2
  heal: {},
  judge: {},
};

/**
 * Claude 앱 방식(ADR 0022)에서 author 가 쓰는 maestro 도구와 그 설명. list_devices 는 기기가 고정이라 내보내지 않는다.
 * 작업 전에도 도구 목록을 줘야 해서 maestro 서버 설명 대신 앱이 정한 설명을 쓴다.
 */
export const MAESTRO_AUTHOR_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  inspect_screen: "배정된 기기 화면의 요소 계층(텍스트·id·접근성 이름·위치)을 읽는다. 선택자를 정할 때 쓴다.",
  take_screenshot: "배정된 기기 화면을 캡처해 이미지로 본다.",
  run: "Maestro 명령(YAML 목록)을 배정된 기기에서 바로 실행한다. 명령 목록만 넣으면 앱이 appId 머리를 붙인다. 계정 값은 ${키 이름} 으로만 쓴다. 실행 전에 앱이 명령을 검사한다. 한 번에 짧은 명령 묶음(대략 30초 안)만 넣는다(Claude 앱의 요청 시간 제한).",
  cheat_sheet: "Maestro 명령 문법 요약을 본다.",
};
