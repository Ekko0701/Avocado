import type { Device } from "@qa/shared";

/** 실행·설치·플로우 만들기에 쓸 수 없는 기기의 안내. 실기기는 켜는 대신 폰에서 허용해야 한다(ADR 0030) */
export function notReady(device: Device): string {
  if (device.kind === "real") return `폰이 준비되지 않았다: ${device.name}. 폰에서 USB 디버깅 허용 창을 확인하고, 케이블을 다시 연결한 뒤 새로고침한다`;
  return `기기가 실행 중이 아니다: ${device.name}. 기기 화면에서 먼저 준비한다`;
}
