import type { DeviceList } from "@qa/shared";
import { useEffect, useRef } from "react";

/** 기기 목록을 저절로 다시 읽는 간격. 케이블을 꽂거나 뺀 것, 시뮬레이터·에뮬레이터가 켜지고 꺼진 것이 이 안에 화면에 반영된다 */
export const DEVICE_POLL_MS = 3000;

/**
 * 화면이 열려 있는 동안 기기 목록을 주기적으로 읽어 onList 에 넘긴다(새로고침을 누르지 않아도 연결이 반영되게).
 * 앞선 요청이 끝나기 전에는 다시 부르지 않고, 창이 가려져 있으면 쉰다. paused 면 읽지 않는다(준비·삭제 중).
 * 실패는 onError 로 넘긴다(조용히 버리지 않는다)
 */
export function useDevicePolling(onList: (list: DeviceList) => void, options: { paused?: boolean; onError?: (error: unknown) => void; intervalMs?: number } = {}): void {
  const handlers = useRef({ onList, onError: options.onError });
  handlers.current = { onList, onError: options.onError };
  const paused = options.paused ?? false;
  const intervalMs = options.intervalMs ?? DEVICE_POLL_MS;
  useEffect(() => {
    if (paused) return;
    let inFlight = false;
    let alive = true;
    const tick = () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      window.qa.devices.list().then(
        (list) => {
          if (alive) handlers.current.onList(list);
        },
        (error: unknown) => {
          if (alive) handlers.current.onError?.(error);
        },
      ).finally(() => {
        inFlight = false;
      });
    };
    const timer = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [paused, intervalMs]);
}
