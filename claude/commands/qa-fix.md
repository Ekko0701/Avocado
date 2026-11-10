---
description: "Dooray QA 티켓 링크로 원인 분석·최소 수정·기기 확인·MR까지 진행"
---

# /qa-fix

Dooray 티켓 링크 하나를 받아 원인 분석, 최소 수정, 빌드와 기기 확인, MR 생성까지 진행한다. 고칠 앱의 저장소에서 실행한다.

```text
/qa-fix https://{회사}.dooray.com/project/tasks/{업무 ID}
```

링크 없이 실행하면 Avocado 의 자동 처리 설정을 따라 다음 티켓을 찾아 한 건을 처리한다.

```text
/qa-fix
```

## 연결 스킬

- `qa-fix` (`skills/qa-fix/SKILL.md`)
