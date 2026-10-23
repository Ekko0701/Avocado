#!/usr/bin/env bash
# 이 Mac 에서 Developer ID 로 서명·공증한 배포용 dmg 를 만든다(T-116, ADR 0020). Releases 에 올리지는 않는다.
#
# 사용법: scripts/release-mac.sh [--no-notarize]
#   기본: 빌드 → 서명 → .app 공증·스테이플 → dmg 서명·공증·스테이플 → 확인 → .sha256
#   --no-notarize: 서명까지만 하고 Apple 에 공증을 제출하지 않는다(서명 확인용, 배포하지 않는다)
#
# 준비(한 번, 사람이 직접):
#   - 키체인에 "Developer ID Application: <이름> (<팀 ID>)" 인증서. 팀 ID 는 앱이 업데이트를 믿는
#     apps/desktop/src/main/update/trust.ts 의 UPDATE_SIGNER_TEAM_ID 와 같아야 한다
#   - 공증 자격을 키체인 프로필로 저장(비밀번호는 프롬프트에서 직접 넣는다. 이 스크립트는 보지 않는다):
#       xcrun notarytool store-credentials avocado-notary --apple-id <Apple ID> --team-id <팀 ID>
#     프로필 이름을 바꾸면 AVOCADO_NOTARY_PROFILE 로 넘긴다
# 커밋하지 않은 변경이 있으면 멈춘다(올린 dmg 가 어느 커밋인지 분명해야 한다).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
PROFILE="${AVOCADO_NOTARY_PROFILE:-avocado-notary}"
NOTARIZE=1
die() { echo "실패: $1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-notarize) NOTARIZE=0; shift ;;
    *) die "모르는 인자: $1" ;;
  esac
done

cd "$ROOT"
TEAM_ID="$(sed -n 's/.*UPDATE_SIGNER_TEAM_ID[^"]*"\([A-Z0-9]\{10\}\)".*/\1/p' apps/desktop/src/main/update/trust.ts)"
[ -n "$TEAM_ID" ] || die "trust.ts 에 UPDATE_SIGNER_TEAM_ID 가 없다"
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
[ -z "$(git status --porcelain)" ] || die "커밋하지 않은 변경이 있다"

echo "== 준비 확인 (v$VERSION, 팀 $TEAM_ID, $(git rev-parse --short HEAD))"
count="$(security find-identity -v -p codesigning | grep -c "\"Developer ID Application: .*($TEAM_ID)\"" || true)"
[ "$count" -eq 1 ] || die "키체인에 팀 $TEAM_ID 의 Developer ID Application 인증서가 ${count}개다(1개여야 한다)"
notarize_flag=false
if [ "$NOTARIZE" -eq 1 ]; then
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || die "공증 프로필 $PROFILE 을 쓸 수 없다(xcrun notarytool store-credentials 로 만든다)"
  # electron-builder(@electron/notarize)가 이 프로필로 .app 을 공증한다
  export APPLE_KEYCHAIN_PROFILE="$PROFILE"
  notarize_flag=true
fi

echo "== 빌드·서명$([ "$NOTARIZE" -eq 1 ] && echo "·.app 공증" || true)"
cd "$DESKTOP"
rm -rf dist
pnpm exec electron-vite build
# 서명 신원을 못 찾으면 멈춘다. electron-builder 는 공증 자격이 없으면 공증을 건너뛰기만 하므로 아래에서 다시 확인한다
pnpm exec electron-builder --config electron-builder.yml --publish never \
  -c.forceCodeSigning=true -c.mac.identity="$TEAM_ID" -c.mac.notarize="$notarize_flag" -c.dmg.sign=true

echo "== .app 확인"
app="dist/mac-arm64/Avocado.app"
codesign --verify --deep --strict --verbose=2 "$app"
# 출력을 먼저 받는다(grep -q 가 일찍 끝나면 pipefail 이 앞 명령의 SIGPIPE 를 실패로 본다)
sig="$(codesign -dv "$app" 2>&1)"
grep -q "^TeamIdentifier=$TEAM_ID\$" <<<"$sig" || die ".app 의 서명 팀이 $TEAM_ID 가 아니다"
grep -q "flags=.*(runtime)" <<<"$sig" || die ".app 에 hardened runtime 이 없다"

if [ "$NOTARIZE" -eq 0 ]; then
  echo "서명까지만 했다(공증 없음). 배포하지 않는다: $DESKTOP/dist"
  exit 0
fi

xcrun stapler validate "$app"
assess="$(spctl --assess --type exec -vv "$app" 2>&1)" || die ".app 을 Gatekeeper 가 거부했다: $assess"
echo "$assess"
grep -q "source=Notarized Developer ID" <<<"$assess" || die ".app 이 공증된 Developer ID 로 인정되지 않는다"

echo "== dmg 공증·스테이플"
# electron-builder 는 .app 만 공증한다. dmg 도 공증·스테이플해 내려받은 dmg 와 앱 내 업데이트의 spctl 확인을 통과하게 한다
for f in dist/*.dmg; do
  result="$(xcrun notarytool submit "$f" --keychain-profile "$PROFILE" --wait --output-format json)"
  status="$(node -e 'const r = JSON.parse(process.argv[1]); process.stdout.write(`${r.status ?? ""} ${r.id ?? ""}`)' "$result")"
  case "$status" in
    "Accepted "*) echo "공증 통과: $f (${status#Accepted })" ;;
    *) die "dmg 공증 실패: $f ($status). 기록: xcrun notarytool log ${status#* } --keychain-profile $PROFILE" ;;
  esac
  xcrun stapler staple "$f"
  xcrun stapler validate "$f"
  assess="$(spctl --assess --type open --context context:primary-signature -vv "$f" 2>&1)" || die "dmg 를 Gatekeeper 가 거부했다: $assess"
  echo "$assess"
  grep -q "source=Notarized Developer ID" <<<"$assess" || die "dmg 가 공증된 Developer ID 로 인정되지 않는다: $f"
  (cd dist && shasum -a 256 "$(basename "$f")" > "$(basename "$f").sha256")
done

echo "== 완료"
ls -l dist/*.dmg dist/*.dmg.sha256
