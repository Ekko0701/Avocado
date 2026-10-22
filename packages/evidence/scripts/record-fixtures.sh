#!/usr/bin/env bash
# T-106: 증적 파서·가림 테스트용 Maestro 실제 산출물 픽스처를 다시 만든다.
#
# 실제 앱 산출물에는 실제 화면·이름·기기 로그가 있어 커밋하지 않는다. 대신 같은 Maestro 버전으로
# 시스템 설정 앱을 실행해 산출물을 만든다. 가짜 비밀 값을 -e 로 넘겨 검색창에 입력하므로,
# 실제 비밀이 남는 자리(commands.json env·evaluatedCommand, maestro.log, 화면 트리, 실패 파일 이름)에 가짜 값이 남는다.
#
# 사용법: packages/evidence/scripts/record-fixtures.sh [ios|android|all]
#   QA_IOS_DEVICE   iOS 시뮬레이터 UDID (기본: 실행 중인 "QA Tool" 시뮬레이터)
#   QA_ANDROID_DEVICE  에뮬레이터 serial (기본: emulator-5554)
#   MAESTRO        maestro 실행 파일 (기본: ~/.maestro/bin/maestro, 2.11.0)
#
# 정리 규칙(커밋 크기·개인정보):
#   - 텍스트 파일의 홈 경로와 사용자 이름을 /Users/tester, tester 로 바꾼다.
#   - 기기 로그(device-*.log, device-*.txt)는 마지막 300줄만 남긴다.
#   - PNG 는 긴 변 480px 로 줄인다(sips). 파서는 내용이 아니라 크기·위치만 본다.
# 드라이버 시작 실패 픽스처(ios-driver-timeout)는 PoC 실제 산출물을 정리해 따로 넣었다(README).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="$HERE/fixtures"
MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
WHICH="${1:-all}"

export MAESTRO_CLI_NO_ANALYTICS=true MAESTRO_DISABLE_UPDATE_CHECK=true MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_DRIVER_STARTUP_TIMEOUT=90000

# 가짜 비밀 값. 실제 계정이 아니다. 테스트가 이 값의 잔존을 검사한다(src/fixtures.ts 와 같아야 한다).
FAKE_ID='qa-fixture-id-7f3a'
FAKE_PW='fixture"Pw&2026'

sanitize() {
  local dir="$1" user
  user="$(id -un)"
  # 텍스트 파일: 홈 경로·사용자 이름 치환
  while IFS= read -r -d '' f; do
    LC_ALL=C sed -i '' -e "s#$HOME#/Users/tester#g" -e "s#$user#tester#g" "$f"
  done < <(find "$dir" -type f \( -name '*.json' -o -name '*.log' -o -name '*.xml' -o -name '*.txt' \) -print0)
  # 기기 로그(iOS device-*.log, Android device-logcat.txt): 마지막 300줄
  while IFS= read -r -d '' f; do
    tail -n 300 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done < <(find "$dir" -type f \( -name 'device-*.log' -o -name 'device-*.txt' \) -print0)
  # PNG: 긴 변 480px
  while IFS= read -r -d '' f; do
    sips -Z 480 "$f" >/dev/null
  done < <(find "$dir" -type f -name '*.png' -print0)
}

record() {
  local name="$1" device="$2" flow="$3"
  local out="$FIX/$name"
  rm -rf "$out"
  mkdir -p "$out/maestro"
  set +e
  "$MAESTRO" --device "$device" test \
    --test-output-dir "$out/maestro" --format junit --output "$out/junit.xml" \
    -e "QA_FIXTURE_ACCOUNT_ID=$FAKE_ID" -e "QA_FIXTURE_ACCOUNT_PW=$FAKE_PW" \
    "$FIX/flows/$flow" > "$out/console.log" 2>&1
  local code=$?
  set -e
  echo "$code" > "$out/exit-code"
  sanitize "$out"
  echo "$name: exit $code"
}

if [ "$WHICH" = ios ] || [ "$WHICH" = all ]; then
  IOS="${QA_IOS_DEVICE:-$(xcrun simctl list devices booted | sed -n 's/^ *QA Tool [^(]*(\([0-9A-F-]*\)) (Booted).*/\1/p' | head -1)}"
  [ -n "$IOS" ] || { echo "실행 중인 QA Tool 시뮬레이터 없음" >&2; exit 2; }
  record ios-pass "$IOS" ios-pass.yaml
  record ios-fail "$IOS" ios-fail.yaml
fi
if [ "$WHICH" = android ] || [ "$WHICH" = all ]; then
  AND="${QA_ANDROID_DEVICE:-emulator-5554}"
  record android-pass "$AND" android-pass.yaml
  record android-fail "$AND" android-fail.yaml
fi
