import type { Device } from "@qa/shared";

/** 기기 고르기 목록의 이름. 실기기는 사람의 폰이라 이름 뒤에 표시한다(ADR 0030) */
export function deviceLabel(d: Pick<Device, "name" | "kind">): string {
  return d.kind === "real" ? `${d.name} (실기기)` : d.name;
}

/** 기기 화면의 설명 줄 */
export function deviceKindText(d: Pick<Device, "platform" | "kind" | "osVersion" | "serial">): string {
  if (d.platform === "ios") return `iOS ${d.osVersion} 시뮬레이터`;
  if (d.kind === "real") return `Android ${d.osVersion ? `${d.osVersion} ` : ""}실기기${d.serial ? ` · ${d.serial}` : ""}`;
  return `Android 에뮬레이터${d.serial ? ` · ${d.serial}` : ""}`;
}
