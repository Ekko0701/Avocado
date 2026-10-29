# 내 Claude 로 플로우 만들기

Avocado 의 "플로우 만들기"는 각자 쓰는 Claude(데스크톱 앱 또는 Claude Code)가 합니다. API 키가 필요 없고, 사용량은 각자의 Claude 요금제 한도에서 나갑니다.

Avocado 는 Claude 에 로그인하지 않습니다. 대신 각자의 Claude 앱에 Avocado 를 "도구(MCP 서버)"로 한 번 등록합니다. 그러면 Claude 대화에서 Avocado 의 기기 도구를 쓸 수 있습니다.

## 1. 한 번만: Claude 에 Avocado 등록

Avocado → 설정 → **Claude 연결**에서 "내 Claude 앱"이 골라져 있는지 확인합니다(기본값).

### Claude 데스크톱 앱

1. **Claude 데스크톱 앱에 등록**을 누릅니다.
   - Claude 앱 설정 파일(`~/Library/Application Support/Claude/claude_desktop_config.json`)에 `avocado` 항목을 더합니다.
   - 다른 항목은 그대로 두고, 바꾸기 전 사본을 `.avocado-backup` 으로 남깁니다.
2. Claude 데스크톱 앱을 완전히 끄고 다시 엽니다.

### Claude Code (터미널, 데스크톱 앱의 Code)

설정 화면의 명령을 **복사**해 터미널에서 한 번 실행합니다. 모양은 아래와 같습니다(소켓 경로는 각자 다릅니다).

```bash
claude mcp add-json --scope user avocado '{"type":"stdio","command":"/usr/bin/nc","args":["-U","/Users/<나>/Library/Application Support/Avocado/mcp/avocado.sock"]}'
```

등록됐는지는 `claude mcp list` 로 봅니다. Avocado 가 켜져 있으면 `avocado` 가 연결됨으로 나옵니다.

## 2. 플로우 만들기

1. **Avocado 를 먼저 켭니다.** Claude 는 켜질 때 Avocado 에 연결합니다.
   - Claude 가 먼저 켜져 있었다면 데스크톱 앱은 다시 시작합니다.
   - Claude Code 는 `/mcp` 에서 avocado 를 다시 연결합니다.
2. Avocado → 플로우 만들기에서 테스트 케이스·타깃·기기·빌드를 고르고 **Claude 로 플로우 만들기**를 누릅니다.
3. 기기 준비가 끝나면 "Claude 에 붙여 넣을 요청"이 나옵니다. **복사**해서 Claude 대화에 붙여 넣습니다.
   - 예: `Avocado 플로우 만들기 작업 …(demo TC-0101 ios)를 진행해 줘. avocado 도구의 attach_author 부터 불러.`
4. Claude 가 작업을 맡으면 Avocado 화면에 진행(스텝·도구 호출)이 보입니다.
   - 다른 메뉴에 갔다가 플로우 만들기로 돌아와도 진행 중인 작업과 붙여 넣을 요청이 다시 보입니다.
   - 작업은 시작할 때 읽은 테스트 케이스로 만듭니다. 작업 중에 그 테스트 케이스를 저장하려 하면 경고가 나옵니다. 테스트 케이스를 고쳐야 하면 작업을 취소하고, 저장한 뒤 다시 시작합니다.
5. Claude 가 플로우를 제출하면 Avocado 가 직접 규약 검사와 2회 재생을 합니다.
   - 실패하면 Claude 에게 이유를 알려 한 번 더 고치게 합니다.
   - 둘 다 통과하면 그 테스트 케이스의 작업 브랜치에 커밋됩니다(다른 테스트 케이스의 브랜치에 섞이지 않습니다). Avocado 에서 **PR 작성**을 누릅니다.

한 작업은 한 대화만 맡습니다. 대화가 끊기면 같은 요청을 새 대화에 붙여 넣어 이어 갑니다. 작업은 60분 안에 끝나야 합니다(기다리는 시간 포함).

## 3. 화면 판정

실행 결과의 캡처가 정상 화면인지 Claude 에게 판정을 맡깁니다. 결과는 스텝 옆 배지로만 보이고 실행 결과(통과·실패)는 바꾸지 않습니다.

1. Avocado → 결과에서 실행을 열고 **Claude 로 화면 판정**을 누릅니다.
2. 나오는 요청을 복사해 Claude 대화에 붙여 넣습니다.
   - 예: `Avocado 화면 판정 작업 …(TC-0101)를 진행해 줘. avocado 도구의 attach_judge 부터 불러.`
3. Claude 가 캡처를 한 장씩 보고 판정을 냅니다. 판정이 들어올 때마다 배지가 생깁니다.

자동 판정(실행이 끝날 때마다 표본 판정)은 Claude 앱 방식에서는 하지 않습니다. 판정은 30분 안에 끝나야 하고, 중간에 취소해도 이미 낸 판정은 남습니다.

## 4. 꼭 지킬 것

- **Avocado 작업 중에는 Claude Code 의 권한 확인을 끄지 않습니다**(bypass·자동 승인 모드 금지).
  - 앱 화면 글자에 "명령을 실행하라" 같은 문장이 섞여 있을 수 있습니다.
  - Avocado 도구는 이런 지시를 막지만, Claude Code 의 셸 도구는 Avocado 가 막을 수 없습니다.
- 화면 캡처와 화면 글자가 **각자의 Claude 계정**으로 갑니다.
  - 개인 요금제(Pro·Max)는 "모델 개선에 참여" 설정에 따라 대화가 학습에 쓰일 수 있습니다.
  - 화면에 민감한 정보가 있는 앱은 요금제와 "모델 개선에 참여" 설정을 먼저 확인한 뒤에 씁니다.
- 계정 비밀번호 같은 값은 Claude 에게 보이지 않습니다. Avocado 가 실행 때 넣고, 결과에서 가립니다.

## 5. 문제가 생기면

| 증상 | 할 일 |
|---|---|
| Claude 에 avocado 도구가 없다 | 1절 등록을 확인하고, Avocado 를 켠 뒤 Claude 를 다시 시작(Code 는 `/mcp`) |
| 설정에 "Claude 연결을 열지 못했습니다: 다른 Avocado…" | 다른 Avocado 창(예: 개발용)을 닫고 Avocado 를 다시 켠다 |
| "이 대화가 맡은 작업이 아니다" | Claude 에게 attach_author(판정은 attach_judge) 부터 부르라고 한다 |
| "다른 Claude 대화가 이 작업을 맡고 있다" | 앞 대화를 닫거나 그 대화에서 이어 간다 |
| API 키로 쓰고 싶다 | 설정 → Claude 연결에서 "Anthropic API 키"를 고르고, API 키와 월 비용 상한을 넣는다 |
