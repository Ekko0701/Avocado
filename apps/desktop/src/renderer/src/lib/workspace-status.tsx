import type { WorkspaceSourceKind, WorkspaceStatus } from "@qa/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onWorkspaceChanged } from "./workspace-events";

interface WorkspaceStatusValue {
  /** 마지막으로 읽은 상태. 처음 읽기 전이나 읽지 못했으면 null */
  status: WorkspaceStatus | null;
  /** 다른 화면이 받은 새 상태(예: 출처를 바꾼 결과)를 바로 반영한다 */
  setStatus: (status: WorkspaceStatus) => void;
  /** 지금 상태를 다시 읽는다 */
  refresh: () => void;
}

const WorkspaceStatusContext = createContext<WorkspaceStatusValue | null>(null);

/**
 * 워크스페이스 상태를 화면들이 같이 본다(ADR 0036). 화면은 로컬인지를 이 상태의 source 하나로만 가른다.
 * 8초마다, 창에 돌아올 때, 다른 화면이 바꿨다고 알릴 때 다시 읽는다
 */
export function WorkspaceStatusProvider(props: { children: ReactNode }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);

  const refresh = useCallback(() => {
    // 읽지 못하면 마지막 상태를 둔다(출처는 그대로다). 오류는 각 화면이 자기 호출에서 보인다
    window.qa.workspace.status().then(setStatus, () => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 8000);
    const off = onWorkspaceChanged(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const value = useMemo(() => ({ status, setStatus, refresh }), [status, refresh]);
  return <WorkspaceStatusContext.Provider value={value}>{props.children}</WorkspaceStatusContext.Provider>;
}

export function useWorkspaceStatus(): WorkspaceStatusValue {
  const value = useContext(WorkspaceStatusContext);
  if (!value) throw new Error("WorkspaceStatusProvider 안에서만 쓴다");
  return value;
}

/** 지금 워크스페이스의 출처. 아직 모르면 null 이고, 그동안은 로컬 요소도 GitHub 요소도 그리지 않는 곳이 있다 */
export function useWorkspaceSource(): WorkspaceSourceKind | null {
  return useWorkspaceStatus().status?.source ?? null;
}
