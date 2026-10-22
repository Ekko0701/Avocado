#!/usr/bin/env bash
# QA_Tool T-000: macOS 개발·러너 환경 준비 스크립트 (멱등)
#
# 사용법:
#   scripts/bootstrap-mac.sh                 # 점검만 (기본, 아무것도 바꾸지 않음)
#   scripts/bootstrap-mac.sh --install       # 빠진 도구 설치 (pnpm, Maestro, Android cmdline-tools, 시스템 이미지, AVD)
#   scripts/bootstrap-mac.sh --write-profile # ~/.zshrc 에 관리 블록(ANDROID_HOME, PATH, Maestro 설정) 기록
#   scripts/bootstrap-mac.sh --boot          # QA용 iOS 시뮬레이터·Android 에뮬레이터 생성/부팅 확인
#   scripts/bootstrap-mac.sh --smoke         # 부팅된 기기에서 Maestro 스모크 플로우 실행 (설정 앱 실행 + 캡처)
#   scripts/bootstrap-mac.sh --all           # --install --write-profile --boot --smoke
#   --agree-android-sdk-terms                # Android SDK 이용 약관을 사람이 읽고 동의했음을 명시 (시스템 이미지 설치에 필요)
#
# 원칙:
#   - 몇 번을 실행해도 같은 결과가 되도록 각 단계는 "이미 되어 있으면 건너뜀".
#   - 라이선스는 절대 자동 수락하지 않는다. 새 Android CLI는 별도 수락 절차 없이 사용을 동의로 보므로,
#     약관이 걸린 설치는 사람이 --agree-android-sdk-terms 를 붙였을 때만 실행한다.
#   - 다운로드는 버전 고정 + 체크섬 검증.
#   - macOS 기본 bash 3.2 호환.

set -euo pipefail

# ---------------------------------------------------------------------------
# 고정 버전과 기본값 (환경 변수로 덮어쓸 수 있음)
# ---------------------------------------------------------------------------
MAESTRO_VERSION="${MAESTRO_VERSION:-2.11.0}"
MAESTRO_SHA256="${MAESTRO_SHA256:-5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a}"

CMDLINE_TOOLS_BUILD="${CMDLINE_TOOLS_BUILD:-16111833}"
CMDLINE_TOOLS_SHA1_ARM64="${CMDLINE_TOOLS_SHA1_ARM64:-ad03dc49bfacfd52c110b14104ea548b8a07e830}"
CMDLINE_TOOLS_SHA1_X86_64="${CMDLINE_TOOLS_SHA1_X86_64:-112cf9618794a997ff273537d55bee02c22abffe}"

PNPM_VERSION="${PNPM_VERSION:-12.10.0}"
NODE_MIN_MAJOR=22
JAVA_MIN_MAJOR=17

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
QA_ANDROID_API="${QA_ANDROID_API:-35}"
QA_AVD_DEVICE="${QA_AVD_DEVICE:-pixel_7}"

QA_IOS_DEVICE_TYPE="${QA_IOS_DEVICE_TYPE:-iPhone 17}"
QA_IOS_RUNTIME="${QA_IOS_RUNTIME:-}"          # 비우면 설치된 최신 iOS 런타임
QA_SIM_NAME="${QA_SIM_NAME:-qa-iphone}"
QA_EMULATOR_WINDOW="${QA_EMULATOR_WINDOW:-0}" # 1이면 에뮬레이터 창 표시

BOOT_TIMEOUT_SEC="${BOOT_TIMEOUT_SEC:-300}"

PROFILE_FILE="${ZDOTDIR:-$HOME}/.zshrc"
PROFILE_BEGIN="# >>> qa-tool bootstrap >>>"
PROFILE_END="# <<< qa-tool bootstrap <<<"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_ROOT/out/bootstrap"
MAESTRO_HOME="$HOME/.maestro"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64) ANDROID_ABI="arm64-v8a"; CMDLINE_TOOLS_ARCH="arm64"; CMDLINE_TOOLS_SHA1="$CMDLINE_TOOLS_SHA1_ARM64" ;;
  x86_64) ANDROID_ABI="x86_64"; CMDLINE_TOOLS_ARCH="x86_64"; CMDLINE_TOOLS_SHA1="$CMDLINE_TOOLS_SHA1_X86_64" ;;
  *) echo "지원하지 않는 아키텍처: $HOST_ARCH" >&2; exit 2 ;;
esac
QA_ANDROID_IMAGE="system-images;android-${QA_ANDROID_API};google_apis;${ANDROID_ABI}"
QA_ANDROID_IMAGE_PATH="system-images/android-${QA_ANDROID_API}/google_apis/${ANDROID_ABI}"  # 새 Android CLI 표기
ANDROID_CLI="$ANDROID_HOME/cmdline-tools/latest/bin/android"
ANDROID_SDK_TERMS_URL="https://developer.android.com/studio/terms"
ANDROIDRC_FILE="$HOME/.androidrc"
QA_ANDROID_IMAGE_DIR="$ANDROID_HOME/system-images/android-${QA_ANDROID_API}/google_apis/${ANDROID_ABI}"
QA_AVD_NAME="${QA_AVD_NAME:-qa_${QA_AVD_DEVICE}_api${QA_ANDROID_API}}"

# 이 스크립트 프로세스 안에서는 프로필을 다시 읽지 않아도 도구를 찾을 수 있게 한다.
export ANDROID_HOME
export PATH="$MAESTRO_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export MAESTRO_CLI_NO_ANALYTICS=true
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_DISABLE_UPDATE_CHECK=true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ---------------------------------------------------------------------------
# 출력 도우미
# ---------------------------------------------------------------------------
if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else C_OK=""; C_WARN=""; C_FAIL=""; C_DIM=""; C_RST=""; fi

SUMMARY_LINES=()
REQUIRED_FAILURES=0

section() { printf '\n== %s ==\n' "$1"; }
info()    { printf '%s  %s%s\n' "$C_DIM" "$1" "$C_RST"; }
record()  { # record <OK|WARN|FAIL|INFO> <항목> <내용> [required]
  local status="$1" item="$2" detail="$3" required="${4:-}"
  local color="$C_DIM"
  case "$status" in OK) color="$C_OK";; WARN) color="$C_WARN";; FAIL) color="$C_FAIL";; esac
  printf '  %s%-4s%s %s: %s\n' "$color" "$status" "$C_RST" "$item" "$detail"
  SUMMARY_LINES+=("$(printf '%-4s %s: %s' "$status" "$item" "$detail")")
  if [ "$status" = "FAIL" ] && [ "$required" = "required" ]; then REQUIRED_FAILURES=$((REQUIRED_FAILURES + 1)); fi
}

# perl alarm으로 타임아웃 (macOS에는 timeout 명령이 없음)
with_timeout() { local secs="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }

download() { # download <url> <dest>
  info "다운로드: $1"
  curl --fail --location --silent --show-error --retry 3 -o "$2" "$1"
}

verify_checksum() { # verify_checksum <algo 1|256> <expected> <file>
  local actual
  actual="$(shasum -a "$1" "$3" | awk '{print $1}')"
  if [ "$actual" != "$2" ]; then
    echo "체크섬 불일치: $3 (기대 $2, 실제 $actual)" >&2
    return 1
  fi
}

major_of() { echo "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'; }

# ---------------------------------------------------------------------------
# 인자
# ---------------------------------------------------------------------------
DO_INSTALL=0; DO_PROFILE=0; DO_BOOT=0; DO_SMOKE=0; AGREE_SDK_TERMS=0
usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
for arg in "$@"; do
  case "$arg" in
    --check) ;;
    --agree-android-sdk-terms) AGREE_SDK_TERMS=1 ;;
    --install) DO_INSTALL=1 ;;
    --write-profile) DO_PROFILE=1 ;;
    --boot) DO_BOOT=1 ;;
    --smoke) DO_SMOKE=1 ;;
    --all) DO_INSTALL=1; DO_PROFILE=1; DO_BOOT=1; DO_SMOKE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $arg" >&2; usage; exit 2 ;;
  esac
done
mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# 1. 호스트 기본 도구
# ---------------------------------------------------------------------------
check_host() {
  section "호스트"
  if [ "$(uname)" = "Darwin" ]; then record OK "macOS" "$(sw_vers -productVersion) ($HOST_ARCH)"
  else record FAIL "macOS" "이 스크립트는 macOS 전용" required; fi

  local xc_path; xc_path="$(xcode-select -p 2>/dev/null || true)"
  if echo "$xc_path" | grep -q "\.app/Contents/Developer"; then
    record OK "Xcode" "$(xcodebuild -version 2>/dev/null | head -1) ($xc_path)"
  else
    record FAIL "Xcode" "xcode-select가 Xcode.app을 가리키지 않음: '${xc_path:-없음}'. 'sudo xcode-select -s /Applications/Xcode.app' 필요" required
  fi
  if xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then record OK "Xcode 첫 실행 구성" "완료"
  else record FAIL "Xcode 첫 실행 구성" "'xcodebuild -runFirstLaunch' 실행 필요(라이선스 동의는 직접)" required; fi

  local runtimes; runtimes="$(xcrun simctl list runtimes 2>/dev/null | grep '^iOS ' | awk '{print $2}' | paste -sd ',' - || true)"
  if [ -n "$runtimes" ]; then record OK "iOS 런타임" "$runtimes"
  else record FAIL "iOS 런타임" "Xcode > Settings > Components에서 iOS 런타임 설치 필요" required; fi

  if command -v java >/dev/null 2>&1; then
    local jv; jv="$(java -version 2>&1 | head -1 | sed -E 's/.*version "([^"]+)".*/\1/')"
    if [ "$(major_of "$jv")" -ge "$JAVA_MIN_MAJOR" ]; then record OK "Java" "$jv (JAVA_HOME=${JAVA_HOME:-미설정})"
    else record FAIL "Java" "$jv, ${JAVA_MIN_MAJOR} 이상 필요" required; fi
  else record FAIL "Java" "없음. Temurin ${JAVA_MIN_MAJOR}+ 설치 필요" required; fi

  if command -v node >/dev/null 2>&1; then
    local nv; nv="$(node --version)"
    if [ "$(major_of "$nv")" -ge "$NODE_MIN_MAJOR" ]; then record OK "Node.js" "$nv"
    else record FAIL "Node.js" "$nv, ${NODE_MIN_MAJOR} 이상 필요" required; fi
  else record FAIL "Node.js" "없음" required; fi
}

# ---------------------------------------------------------------------------
# 2. pnpm (corepack)
# ---------------------------------------------------------------------------
pnpm_version() { pnpm --version 2>/dev/null || true; }
ensure_pnpm() {
  section "pnpm"
  local current; current="$(pnpm_version)"
  if [ "$current" = "$PNPM_VERSION" ]; then record OK "pnpm" "$current"; return; fi
  if [ "$DO_INSTALL" -eq 1 ]; then
    if ! command -v corepack >/dev/null 2>&1; then
      record FAIL "pnpm" "corepack 없음. 'npm i -g corepack' 후 재실행" required; return
    fi
    info "corepack enable pnpm && corepack install -g pnpm@$PNPM_VERSION"
    corepack enable pnpm
    corepack install -g "pnpm@$PNPM_VERSION" >/dev/null
    current="$(pnpm_version)"
    if [ "$current" = "$PNPM_VERSION" ]; then record OK "pnpm" "$current (설치함, corepack)"
    else record FAIL "pnpm" "설치 후에도 버전이 '${current:-없음}'" required; fi
  elif [ -n "$current" ]; then
    record WARN "pnpm" "$current (고정 버전 $PNPM_VERSION 아님, --install로 맞춤)"
  else
    record FAIL "pnpm" "없음 (--install로 설치)" required
  fi
}

# ---------------------------------------------------------------------------
# 3. Maestro CLI (GitHub 릴리스 zip, 버전 고정 + SHA-256 검증)
#    공식 설치 스크립트와 같은 위치(~/.maestro)에 설치하되, 셸 rc 파일은 건드리지 않는다.
# ---------------------------------------------------------------------------
maestro_version() { "$MAESTRO_HOME/bin/maestro" --version 2>/dev/null | tail -1 | tr -d '[:space:]' || true; }
ensure_maestro() {
  section "Maestro CLI"
  local other; other="$(command -v maestro 2>/dev/null || true)"
  if [ -n "$other" ] && [ "$other" != "$MAESTRO_HOME/bin/maestro" ]; then
    record WARN "Maestro 위치" "다른 설치가 PATH에 있음: $other (Homebrew 설치라면 제거 권장)"
  fi
  local current=""
  if [ -x "$MAESTRO_HOME/bin/maestro" ]; then current="$(maestro_version)"; fi
  if [ "$current" = "$MAESTRO_VERSION" ]; then record OK "Maestro" "$current ($MAESTRO_HOME/bin)"; return; fi
  if [ "$DO_INSTALL" -ne 1 ]; then
    if [ -n "$current" ]; then record WARN "Maestro" "$current (고정 버전 $MAESTRO_VERSION 아님, --install로 맞춤)"
    else record FAIL "Maestro" "없음 (--install로 설치, 약 300MB)" required; fi
    return
  fi
  local tmp; tmp="$(mktemp -d)"
  download "https://github.com/mobile-dev-inc/maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip" "$tmp/maestro.zip"
  verify_checksum 256 "$MAESTRO_SHA256" "$tmp/maestro.zip"
  unzip -tq "$tmp/maestro.zip" >/dev/null
  unzip -q "$tmp/maestro.zip" -d "$tmp/x"
  if [ ! -x "$tmp/x/maestro/bin/maestro" ]; then
    record FAIL "Maestro" "압축 구조가 예상과 다름(maestro/bin/maestro 없음)" required; rm -rf "$tmp"; return
  fi
  mkdir -p "$MAESTRO_HOME"
  # 공식 설치 스크립트와 동일하게 bin/lib만 교체한다. ~/.maestro/tests 등 기존 산출물은 유지.
  rm -rf "$MAESTRO_HOME/bin" "$MAESTRO_HOME/lib"
  cp -R "$tmp/x/maestro/." "$MAESTRO_HOME/"
  rm -rf "$tmp"
  current="$(maestro_version)"
  if [ "$current" = "$MAESTRO_VERSION" ]; then record OK "Maestro" "$current (설치함, $MAESTRO_HOME/bin)"
  else record FAIL "Maestro" "설치 후 버전 확인 실패: '${current:-출력 없음}'" required; fi
}

# ---------------------------------------------------------------------------
# 4. Android SDK, cmdline-tools, 시스템 이미지, AVD
# ---------------------------------------------------------------------------
ensure_android_sdk() {
  section "Android SDK"
  if [ -d "$ANDROID_HOME" ]; then record OK "ANDROID_HOME" "$ANDROID_HOME"
  else record FAIL "ANDROID_HOME" "$ANDROID_HOME 없음. Android Studio로 SDK 설치 필요" required; return; fi

  if [ -x "$ANDROID_HOME/platform-tools/adb" ]; then record OK "adb" "$("$ANDROID_HOME/platform-tools/adb" version | head -1)"
  else record FAIL "adb" "platform-tools 없음. Android Studio SDK Manager에서 설치" required; fi

  if [ -x "$ANDROID_HOME/emulator/emulator" ]; then record OK "emulator" "$("$ANDROID_HOME/emulator/emulator" -version 2>/dev/null | head -1 | sed 's/Android emulator version //')"
  else record FAIL "emulator" "emulator 패키지 없음. Android Studio SDK Manager에서 설치" required; fi

  ensure_cmdline_tools
  ensure_system_image
  ensure_avd
}

ensure_cmdline_tools() {
  local sdkm="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  if [ -x "$sdkm" ]; then
    record OK "cmdline-tools" "rev $(grep -E '^Pkg.Revision' "$ANDROID_HOME/cmdline-tools/latest/source.properties" 2>/dev/null | cut -d= -f2)"
    return
  fi
  if [ "$DO_INSTALL" -ne 1 ]; then record FAIL "cmdline-tools" "없음 (--install로 설치, 약 150MB)" required; return; fi
  # cmdline-tools 는 android-sdk-license 를 요구한다. 이미 수락된 경우에만 진행한다.
  if [ ! -f "$ANDROID_HOME/licenses/android-sdk-license" ]; then
    record FAIL "cmdline-tools" "android-sdk-license 미수락. Android Studio SDK Manager에서 'Android SDK Command-line Tools' 설치" required; return
  fi
  local tmp zip; tmp="$(mktemp -d)"
  zip="commandlinetools-mac_${CMDLINE_TOOLS_ARCH}-${CMDLINE_TOOLS_BUILD}_latest.zip"
  download "https://dl.google.com/android/repository/$zip" "$tmp/$zip"
  verify_checksum 1 "$CMDLINE_TOOLS_SHA1" "$tmp/$zip"
  unzip -q "$tmp/$zip" -d "$tmp/x"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/x/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
  if [ -x "$sdkm" ]; then record OK "cmdline-tools" "설치함 (build $CMDLINE_TOOLS_BUILD)"
  else record FAIL "cmdline-tools" "설치 후 sdkmanager 없음" required; fi
}

ensure_system_image() {
  if [ -f "$QA_ANDROID_IMAGE_DIR/source.properties" ]; then record OK "시스템 이미지" "$QA_ANDROID_IMAGE"; return; fi
  if [ "$DO_INSTALL" -ne 1 ]; then record FAIL "시스템 이미지" "$QA_ANDROID_IMAGE_PATH 없음 (--install --agree-android-sdk-terms로 설치, 약 1.7GB)" required; return; fi
  if [ ! -x "$ANDROID_CLI" ]; then record FAIL "시스템 이미지" "cmdline-tools(android CLI)가 먼저 필요" required; return; fi
  # Google APIs ARM 이미지는 예전 sdkmanager 기준 android-sdk-arm-dbt-license 를 요구했다.
  # cmdline-tools 23부터 sdkmanager --licenses 는 폐기됐고, 새 android CLI는 별도 수락 절차 없이
  # 사용을 Android SDK 이용 약관 동의로 본다. 그래서 사람이 명시적으로 동의한 경우에만 설치한다.
  if [ ! -f "$ANDROID_HOME/licenses/android-sdk-arm-dbt-license" ] && [ "$AGREE_SDK_TERMS" -ne 1 ]; then
    record FAIL "시스템 이미지" "약관 동의 필요: $ANDROID_SDK_TERMS_URL 을 읽고 동의하면 --agree-android-sdk-terms 를 붙여 다시 실행" required
    return
  fi
  info "android --no-metrics sdk install $QA_ANDROID_IMAGE_PATH (약 1.7GB, 수 분 소요)"
  # stdin을 닫아 두어 예상치 못한 대화형 프롬프트가 뜨면 멈추지 않고 실패하게 한다.
  if "$ANDROID_CLI" --no-metrics --sdk="$ANDROID_HOME" sdk install "$QA_ANDROID_IMAGE_PATH" </dev/null \
       && [ -f "$QA_ANDROID_IMAGE_DIR/source.properties" ]; then
    record OK "시스템 이미지" "$QA_ANDROID_IMAGE_PATH (설치함)"
  else
    record FAIL "시스템 이미지" "android sdk install 실패 또는 설치 위치에 이미지 없음 ($QA_ANDROID_IMAGE_DIR)" required
  fi
}

avd_exists() { "$ANDROID_HOME/emulator/emulator" -list-avds 2>/dev/null | grep -qx "$QA_AVD_NAME"; }
ensure_avd() {
  if avd_exists; then record OK "AVD" "$QA_AVD_NAME"; return; fi
  if [ "$DO_INSTALL" -ne 1 ]; then record FAIL "AVD" "$QA_AVD_NAME 없음 (--install로 생성)" required; return; fi
  local avdm="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
  if [ ! -x "$avdm" ] || [ ! -f "$QA_ANDROID_IMAGE_DIR/source.properties" ]; then
    record FAIL "AVD" "cmdline-tools와 시스템 이미지가 먼저 필요" required; return
  fi
  if ! "$avdm" list device -c 2>/dev/null | grep -qx "$QA_AVD_DEVICE"; then
    record FAIL "AVD" "기기 프로필 '$QA_AVD_DEVICE' 없음. 'avdmanager list device -c'로 확인 후 QA_AVD_DEVICE 지정" required; return
  fi
  # "custom hardware profile?" 질문에 기본값(no)으로 답한다. 라이선스 프롬프트가 아니다.
  echo "no" | "$avdm" create avd -n "$QA_AVD_NAME" -k "$QA_ANDROID_IMAGE" -d "$QA_AVD_DEVICE" >/dev/null
  if avd_exists; then record OK "AVD" "$QA_AVD_NAME (생성함, $QA_AVD_DEVICE)"
  else record FAIL "AVD" "생성 실패" required; fi
}

# ---------------------------------------------------------------------------
# 5. 셸 프로필 관리 블록
# ---------------------------------------------------------------------------
profile_block() {
  cat <<EOF
$PROFILE_BEGIN
# QA_Tool scripts/bootstrap-mac.sh 가 관리하는 블록. 지우면 원상복구된다.
export ANDROID_HOME="$ANDROID_HOME"
export PATH="\$HOME/.maestro/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
export MAESTRO_CLI_NO_ANALYTICS=true
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_DISABLE_UPDATE_CHECK=true
$PROFILE_END
EOF
}

current_profile_block() {
  [ -f "$PROFILE_FILE" ] || return 0
  awk -v b="$PROFILE_BEGIN" -v e="$PROFILE_END" '$0==b{f=1} f{print} $0==e{f=0}' "$PROFILE_FILE"
}

ensure_profile() {
  section "셸 프로필"
  local want have
  want="$(profile_block)"; have="$(current_profile_block)"
  if [ "$want" = "$have" ]; then record OK "프로필 블록" "$PROFILE_FILE"; return; fi
  if [ "$DO_PROFILE" -ne 1 ]; then
    if [ -n "$have" ]; then record WARN "프로필 블록" "내용이 오래됨 (--write-profile로 갱신)"
    else record WARN "프로필 블록" "없음 (--write-profile로 기록, 새 터미널부터 적용)"; fi
    return
  fi
  touch "$PROFILE_FILE"
  local backup; backup="$PROFILE_FILE.qa-tool.bak.$(date +%Y%m%d%H%M%S)"
  cp "$PROFILE_FILE" "$backup"
  local tmp; tmp="$(mktemp)"
  awk -v b="$PROFILE_BEGIN" -v e="$PROFILE_END" '$0==b{skip=1; next} $0==e{skip=0; next} !skip{print}' "$PROFILE_FILE" > "$tmp"
  { cat "$tmp"; printf '\n%s\n' "$want"; } > "$PROFILE_FILE"
  rm -f "$tmp"
  record OK "프로필 블록" "기록함 ($PROFILE_FILE, 백업 $(basename "$backup"))"
}

# 새 android CLI는 사용 데이터 수집이 기본으로 켜져 있다. ~/.androidrc 의 플래그는 모든 호출에 적용된다.
ensure_androidrc() {
  if [ -f "$ANDROIDRC_FILE" ] && grep -qx -- "--no-metrics" "$ANDROIDRC_FILE"; then
    record OK "Android CLI 수집 끔" "$ANDROIDRC_FILE (--no-metrics)"; return
  fi
  if [ "$DO_PROFILE" -ne 1 ]; then
    record WARN "Android CLI 수집 끔" "$ANDROIDRC_FILE 에 --no-metrics 없음 (--write-profile로 추가)"; return
  fi
  if [ -f "$ANDROIDRC_FILE" ]; then cp "$ANDROIDRC_FILE" "$ANDROIDRC_FILE.qa-tool.bak.$(date +%Y%m%d%H%M%S)"; fi
  echo "--no-metrics" >> "$ANDROIDRC_FILE"
  record OK "Android CLI 수집 끔" "추가함 ($ANDROIDRC_FILE)"
}

# ---------------------------------------------------------------------------
# 6. 기기 부팅
# ---------------------------------------------------------------------------
IOS_UDID=""
ANDROID_SERIAL_QA=""

pick_ios_runtime() { # pick_ios_runtime <기기 유형 이름> [런타임 식별자]
  # 기기 유형을 지원하는 런타임 중 가장 최신 것을 고른다. 런타임을 지정하면 지원 여부만 검사한다.
  # 일부 런타임(예: 베타)은 극소수 기기만 지원하므로 "최신 런타임"을 그대로 쓰면 생성이 실패한다.
  xcrun simctl list runtimes -j | python3 -c '
import json,sys
dtype, wanted = sys.argv[1], sys.argv[2]
rs=[r for r in json.load(sys.stdin)["runtimes"]
    if r.get("isAvailable") and (r.get("platform")=="iOS" or r.get("name","").startswith("iOS"))
    and any(d.get("name")==dtype for d in r.get("supportedDeviceTypes",[]))]
if wanted:
    rs=[r for r in rs if r["identifier"]==wanted]
rs.sort(key=lambda r: [int(x) for x in r["version"].split(".")])
print(rs[-1]["identifier"] if rs else "")' "$1" "${2:-}"
}

find_sim_udid() { # find_sim_udid <name>
  xcrun simctl list devices -j | python3 -c '
import json,sys
name=sys.argv[1]
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d["name"]==name and d.get("isAvailable",True):
            print(d["udid"]); sys.exit(0)' "$1"
}

sim_state() { # sim_state <udid>
  xcrun simctl list devices -j | python3 -c '
import json,sys
u=sys.argv[1]
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d["udid"]==u: print(d["state"]); sys.exit(0)' "$1"
}

boot_ios() {
  section "iOS 시뮬레이터"
  local runtime; runtime="$(pick_ios_runtime "$QA_IOS_DEVICE_TYPE" "$QA_IOS_RUNTIME")"
  IOS_UDID="$(find_sim_udid "$QA_SIM_NAME")"
  if [ -z "$IOS_UDID" ]; then
    if [ -z "$runtime" ]; then
      record FAIL "시뮬레이터" "'$QA_IOS_DEVICE_TYPE'을 지원하는 iOS 런타임 없음${QA_IOS_RUNTIME:+ (지정: $QA_IOS_RUNTIME)}. QA_IOS_DEVICE_TYPE 또는 QA_IOS_RUNTIME 조정" required
      return
    fi
    local dtype; dtype="com.apple.CoreSimulator.SimDeviceType.$(echo "$QA_IOS_DEVICE_TYPE" | tr ' ' '-')"
    info "xcrun simctl create \"$QA_SIM_NAME\" $dtype $runtime"
    if ! IOS_UDID="$(xcrun simctl create "$QA_SIM_NAME" "$dtype" "$runtime" 2>"$STATE_DIR/simctl-create.err")"; then
      record FAIL "시뮬레이터" "생성 실패: $(tr '\n' ' ' < "$STATE_DIR/simctl-create.err")" required
      IOS_UDID=""; return
    fi
  fi
  if [ "$(sim_state "$IOS_UDID")" != "Booted" ]; then
    info "xcrun simctl boot $IOS_UDID"
    if ! xcrun simctl boot "$IOS_UDID" 2>"$STATE_DIR/simctl-boot.err"; then
      record FAIL "시뮬레이터" "부팅 실패: $(tr '\n' ' ' < "$STATE_DIR/simctl-boot.err")" required
      return
    fi
  fi
  runtime="$(xcrun simctl list devices -j | python3 -c '
import json,sys
u=sys.argv[1]
for rt,devs in json.load(sys.stdin)["devices"].items():
    if any(d["udid"]==u for d in devs): print(rt)' "$IOS_UDID")"
  if with_timeout "$BOOT_TIMEOUT_SEC" xcrun simctl bootstatus "$IOS_UDID" -b >/dev/null 2>&1; then
    record OK "시뮬레이터" "$QA_SIM_NAME ($QA_IOS_DEVICE_TYPE, $(echo "$runtime" | sed 's/.*SimRuntime\.//'), $IOS_UDID) Booted"
    echo "$IOS_UDID" > "$STATE_DIR/ios-udid"
  else
    record FAIL "시뮬레이터" "${BOOT_TIMEOUT_SEC}초 안에 부팅 완료되지 않음 ($IOS_UDID)" required
  fi
}

emulator_serial_for_avd() { # 실행 중인 에뮬레이터 중 QA AVD의 serial을 출력
  local s name
  for s in $(adb devices 2>/dev/null | awk '/^emulator-[0-9]+/{print $1}'); do
    name="$(adb -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r' || true)"
    if [ "$name" = "$QA_AVD_NAME" ]; then echo "$s"; return 0; fi
  done
  return 0
}

boot_android() {
  section "Android 에뮬레이터"
  if ! avd_exists; then record FAIL "에뮬레이터" "AVD $QA_AVD_NAME 없음 (--install 먼저)" required; return; fi
  adb start-server >/dev/null 2>&1 || true
  ANDROID_SERIAL_QA="$(emulator_serial_for_avd)"
  if [ -z "$ANDROID_SERIAL_QA" ]; then
    local log="$STATE_DIR/emulator-$QA_AVD_NAME.log"
    local window_flag="-no-window"
    if [ "$QA_EMULATOR_WINDOW" = "1" ]; then window_flag=""; fi
    info "emulator -avd $QA_AVD_NAME $window_flag -no-audio -no-boot-anim -no-snapshot-save (로그: ${log#"$REPO_ROOT"/})"
    # shellcheck disable=SC2086
    nohup "$ANDROID_HOME/emulator/emulator" -avd "$QA_AVD_NAME" $window_flag -no-audio -no-boot-anim -no-snapshot-save >"$log" 2>&1 &
    local waited=0
    while [ -z "$ANDROID_SERIAL_QA" ] && [ "$waited" -lt "$BOOT_TIMEOUT_SEC" ]; do
      sleep 3; waited=$((waited + 3))
      ANDROID_SERIAL_QA="$(emulator_serial_for_avd)"
    done
    if [ -z "$ANDROID_SERIAL_QA" ]; then record FAIL "에뮬레이터" "adb에 나타나지 않음. 로그: $log" required; return; fi
  fi
  local waited=0 booted=""
  while [ "$waited" -lt "$BOOT_TIMEOUT_SEC" ]; do
    booted="$(adb -s "$ANDROID_SERIAL_QA" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [ "$booted" = "1" ]; then break; fi
    sleep 3; waited=$((waited + 3))
  done
  if [ "$booted" != "1" ]; then record FAIL "에뮬레이터" "${BOOT_TIMEOUT_SEC}초 안에 부팅 완료되지 않음 ($ANDROID_SERIAL_QA)" required; return; fi
  local k
  for k in window_animation_scale transition_animation_scale animator_duration_scale; do
    adb -s "$ANDROID_SERIAL_QA" shell settings put global "$k" 0 >/dev/null 2>&1 || true
  done
  local release; release="$(adb -s "$ANDROID_SERIAL_QA" shell getprop ro.build.version.release | tr -d '\r')"
  record OK "에뮬레이터" "$QA_AVD_NAME ($ANDROID_SERIAL_QA, Android $release) Booted, 애니메이션 끔"
  echo "$ANDROID_SERIAL_QA" > "$STATE_DIR/android-serial"
}

report_devices_check_only() {
  section "기기 (점검)"
  local udid; udid="$(find_sim_udid "$QA_SIM_NAME")"
  if [ -n "$udid" ]; then record INFO "시뮬레이터" "$QA_SIM_NAME $udid ($(sim_state "$udid"))"
  else record INFO "시뮬레이터" "$QA_SIM_NAME 아직 없음 (--boot 시 생성)"; fi
  if [ -x "$ANDROID_HOME/emulator/emulator" ] && avd_exists; then
    local s; s="$(emulator_serial_for_avd)"
    if [ -n "$s" ]; then record INFO "에뮬레이터" "$QA_AVD_NAME 실행 중 ($s)"
    else record INFO "에뮬레이터" "$QA_AVD_NAME 정지 (--boot 시 시작)"; fi
  else
    record INFO "에뮬레이터" "AVD $QA_AVD_NAME 아직 없음"
  fi
}

# ---------------------------------------------------------------------------
# 7. Maestro 스모크
# ---------------------------------------------------------------------------
run_smoke() { # run_smoke <platform> <device-id> <flow>
  local platform="$1" device="$2" flow="$3"
  local out; out="$REPO_ROOT/out/bootstrap-smoke/$(date +%Y%m%d-%H%M%S)-$platform"
  mkdir -p "$out"
  info "maestro --device $device test --test-output-dir ${out#"$REPO_ROOT"/} --format junit ${flow#"$REPO_ROOT"/}"
  if "$MAESTRO_HOME/bin/maestro" --device "$device" test \
       --test-output-dir "$out" --format junit --output "$out/junit.xml" \
       "$flow" >"$out/console.log" 2>&1; then
    local shot; shot="$(find "$out" -path '*takeScreenshot*' -name '*.png' | head -1)"
    if [ -n "$shot" ]; then record OK "스모크 $platform" "통과, 캡처 ${shot#"$REPO_ROOT"/}"
    else record WARN "스모크 $platform" "통과했지만 캡처 파일을 찾지 못함 (${out#"$REPO_ROOT"/})"; fi
  else
    record FAIL "스모크 $platform" "실패. 로그: ${out#"$REPO_ROOT"/}/console.log" required
  fi
}

smoke() {
  section "Maestro 스모크"
  if [ ! -x "$MAESTRO_HOME/bin/maestro" ]; then record FAIL "스모크" "Maestro 없음" required; return; fi
  local udid serial
  udid="${IOS_UDID:-$(cat "$STATE_DIR/ios-udid" 2>/dev/null || true)}"
  serial="${ANDROID_SERIAL_QA:-$(cat "$STATE_DIR/android-serial" 2>/dev/null || true)}"
  if [ -n "$udid" ] && [ "$(sim_state "$udid")" = "Booted" ]; then
    run_smoke ios "$udid" "$REPO_ROOT/scripts/smoke/ios-settings.yaml"
  else
    record FAIL "스모크 ios" "부팅된 QA 시뮬레이터 없음 (--boot 먼저)" required
  fi
  if [ -n "$serial" ] && adb -s "$serial" get-state >/dev/null 2>&1; then
    run_smoke android "$serial" "$REPO_ROOT/scripts/smoke/android-settings.yaml"
  else
    record FAIL "스모크 android" "부팅된 QA 에뮬레이터 없음 (--boot 먼저)" required
  fi
}

# ---------------------------------------------------------------------------
# 8. 참고 정보 (M1에서 필요)
# ---------------------------------------------------------------------------
check_extras() {
  section "참고 (M1 이후 필요)"
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then record INFO "Docker" "$(docker --version | sed 's/,.*//') 데몬 실행 중"
    else record INFO "Docker" "설치됨, 데몬 정지 (M1의 Postgres·MinIO에 필요)"; fi
  else record INFO "Docker" "없음 (M1에 필요)"; fi
  if command -v flutter >/dev/null 2>&1; then record INFO "Flutter" "$(flutter --version 2>/dev/null | head -1 | awk '{print $2}')"
  else record INFO "Flutter" "PATH에 없음 (Flutter 앱 빌드 시 필요)"; fi
}

# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------
mode="점검"
if [ "$DO_INSTALL" -eq 1 ]; then mode="$mode+설치"; fi
if [ "$DO_PROFILE" -eq 1 ]; then mode="$mode+프로필"; fi
if [ "$DO_BOOT" -eq 1 ]; then mode="$mode+부팅"; fi
if [ "$DO_SMOKE" -eq 1 ]; then mode="$mode+스모크"; fi
echo "QA_Tool bootstrap ($mode) — Maestro $MAESTRO_VERSION, pnpm $PNPM_VERSION, Android API $QA_ANDROID_API"

check_host
ensure_pnpm
ensure_maestro
ensure_android_sdk
ensure_profile
ensure_androidrc
if [ "$DO_BOOT" -eq 1 ]; then boot_ios; boot_android; else report_devices_check_only; fi
if [ "$DO_SMOKE" -eq 1 ]; then smoke; fi
check_extras

section "요약"
for line in "${SUMMARY_LINES[@]}"; do echo "  $line"; done
if [ "$REQUIRED_FAILURES" -gt 0 ]; then
  printf '\n%s필수 항목 %d개 미충족.%s 위 FAIL 항목의 안내를 따르세요.\n' "$C_FAIL" "$REQUIRED_FAILURES" "$C_RST"
  exit 1
fi
printf '\n%s필수 항목 모두 충족.%s\n' "$C_OK" "$C_RST"
