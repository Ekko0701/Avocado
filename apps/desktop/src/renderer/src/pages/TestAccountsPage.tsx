import type { SecretsList } from "@qa/shared";
import { useCallback, useEffect, useState } from "react";
import { AccountValues } from "../components/AccountValues";
import { errorMessage } from "../lib/errors";

/**
 * 테스트 계정(검증 구역). 플로우가 ${KEY} 로 쓰는 계정 값을 각자 이 Mac 에 넣는다.
 * 키 이름·계정 역할은 워크스페이스 앱 설정(accounts.yaml)에서 팀이 PR 로 바꾼다
 */
export function TestAccountsPage(props: { onOpenWorkspace: () => void; onChanged: () => void }) {
  const [secrets, setSecrets] = useState<SecretsList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSecrets(await window.qa.secrets.list());
      setError(null);
    } catch (e) {
      setError(`저장된 값을 읽지 못했습니다: ${errorMessage(e)}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="split-page">
      <h1>테스트 계정</h1>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {secrets && !secrets.encryptionAvailable ? (
        <p role="alert" className="error">
          이 Mac에서 키체인 암호화를 쓸 수 없어 값을 저장할 수 없습니다. 평문으로 대신 저장하지 않습니다.
        </p>
      ) : null}
      {secrets ? (
        <AccountValues
          secrets={secrets.items.filter((s) => s.name.startsWith("account:"))}
          locked={!secrets.encryptionAvailable}
          onOpenWorkspace={props.onOpenWorkspace}
          onChanged={async () => {
            await reload();
            props.onChanged();
          }}
        />
      ) : (
        <p>불러오는 중</p>
      )}
    </div>
  );
}
