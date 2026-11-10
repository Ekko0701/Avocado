# Claude Code 용 QA 티켓 수정 스킬

Dooray QA 티켓 링크를 주면 Claude Code 가 원인 분석, 최소 수정, 기기 확인, MR 생성까지 진행하는 스킬이다.
진행 상황과 기기 실행 증적은 Avocado 의 "QA 작업" 화면에 남는다(사이드 브랜치 `side/qa-fix-monitor`).

## 설치

각자의 Mac 에서 한 번 연결한다. 이 저장소의 파일을 가리키므로 저장소를 받으면 내용도 같이 바뀐다.

```bash
mkdir -p ~/.claude/skills ~/.claude/commands
ln -s "$(pwd)/claude/skills/qa-fix" ~/.claude/skills/qa-fix
ln -s "$(pwd)/claude/commands/qa-fix.md" ~/.claude/commands/qa-fix.md
```

Avocado 를 Claude Code 에 등록하는 방법은 [내 Claude 로 플로우 만들기](../docs/user-guide/claude-connect.md) 1절과 같다.

## 사용

고칠 앱의 저장소에서 Claude Code 를 열고 티켓 링크를 준다.

```text
/qa-fix https://{회사}.dooray.com/project/tasks/{업무 ID}
```

지금은 Android 앱만 다룬다.
