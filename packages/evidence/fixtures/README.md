# 증적 픽스처 (T-106)

Maestro 2.11.0이 실제로 만든 산출물이다. 파서와 가림 테스트가 쓴다. 폴더 구조는 실행 엔진(T-107)이 실행 하나마다 남기는 구조와 같다.

```
<픽스처>/
├── console.log    maestro 표준 출력과 오류
├── junit.xml      --format junit --output (드라이버 실패 시 없음)
├── exit-code      maestro 종료 코드 (PoC 실행은 기록하지 않아 없음)
└── maestro/       --test-output-dir
    └── <YYYY-MM-DD_HHMMSS>/<플로우 name>/ commands.json, manifest.json, logs/, takeScreenshot/, screenshots/, screen-hierarchy/
```

| 픽스처 | 결과 | 출처 |
|---|---|---|
| `ios-pass` | 통과 | iOS 설정 앱, `flows/ios-pass.yaml` |
| `ios-fail` | 실패: 요소 없음 | iOS 설정 앱, `flows/ios-fail.yaml` |
| `android-pass` | 통과 | Android 설정 앱, `flows/android-pass.yaml` |
| `android-fail` | 실패: 요소 없음 | Android 설정 앱, `flows/android-fail.yaml` |
| `ios-driver-timeout` | 드라이버 시작 실패 | PoC 실제 실행(2026-10-21 15:03). 플로우 폴더 없이 러너 로그와 콘솔만 남았다 |

## 왜 PoC 앱 산출물을 그대로 쓰지 않았나

PoC 에서 쓴 실제 앱의 산출물에는 앱 화면, 화면 트리의 실제 이름·학교 정보, 앱이 기기 로그에 쓴 내용이 있다. 픽스처에 실제 사용자 정보를 두지 않는다는 규칙(CLAUDE.md 4장)에 따라, 같은 Maestro 버전으로 시스템 설정 앱을 실행해 다시 만들었다. PoC 산출물은 로컬에서만 따로 켜는 테스트(`QA_EVIDENCE_POC_RUNS`)로 파싱을 확인한다. 드라이버 시작 실패는 일부러 재현하기 어려워 PoC 산출물을 썼다. 화면이나 사용자 정보가 없는 콘솔과 러너 로그뿐이다.

## 가짜 비밀 값

`scripts/record-fixtures.sh`가 아래 가짜 값을 `-e`로 넘기고 검색창에 계정 값을 입력한다. 실제 계정이 아니다. 실제 비밀이 남는 자리에 이 값이 남아 있어서, 가림 테스트가 원본에서는 값을 찾고 가린 사본에서는 찾지 못하는지 확인한다.

| 키 | 값 | 남은 곳 |
|---|---|---|
| `QA_FIXTURE_ACCOUNT_ID` | `qa-fixture-id-7f3a` | `commands.json`(env, 입력 명령, 실패 선택자), `maestro.log`, 화면 트리(검색창 값), `junit.xml`·`console.log`의 실패 메시지 |
| `QA_FIXTURE_ACCOUNT_PW` | `fixture"Pw&2026` | `commands.json` env(JSON 이스케이프 `\"`), `console.log`(Maestro 인자 해석 경고에 원문) |

실패 캡처·트리 파일 이름에는 값이 아니라 변수 이름(`${QA_FIXTURE_ACCOUNT_ID}_없음`)이 들어갔다. 플로우에 값을 직접 쓰면 파일 이름에도 값이 들어간다.

## 정리한 것

- 텍스트 파일의 홈 경로와 사용자 이름을 `/Users/tester`, `tester`로 바꿨다.
- 기기 로그(`device-simulator.log`, `device-xctest.log`, `device-logcat.txt`)는 마지막 300줄만 남겼다.
- PNG는 긴 변 480px로 줄였다. 그래서 `manifest.json`의 크기 값과 실제 파일 크기가 다르다.
- `sips`가 다시 쓴 `ios-fail`의 실패 캡처는 한글 파일 이름이 NFD가 됐다(Maestro는 NFC로 쓴다). macOS 도구가 만들 수 있는 상황이라 그대로 두고, 파서의 NFC 정규화를 이 픽스처로 확인한다.

다시 만들기: QA 시뮬레이터와 에뮬레이터를 켜고 `packages/evidence/scripts/record-fixtures.sh all`.
