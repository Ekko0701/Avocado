#!/usr/bin/env bash
# T-110: qa-workspace 템플릿 저장소를 로컬에 만든다(PLAN 4.1). 네트워크에는 아무것도 하지 않는다.
#
# 사용법: scripts/workspace/create-workspace-repo.sh <새 폴더> [--owner <GitHub 조직>] [--reviewers <@조직/팀>] [--template <폴더>]
#   - 템플릿(기본 examples/qa-workspace, --template 으로 바꾼다)을 복사하고 git 저장소(main)로 첫 커밋을 만든다.
#   - --owner/--reviewers 를 주면 CODEOWNERS 의 플로우 승인자를 채운다(D10).
#   - GitHub 에 저장소를 만들고 main 보호를 켜는 일은 조직 관리자가 한다. 끝에 명령과 설정을 안내한다.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/examples/qa-workspace"
die() { echo "실패: $1" >&2; exit 1; }

[ $# -ge 1 ] || die "사용법: $0 <새 폴더> [--owner <조직>] [--reviewers <@조직/팀>]"
TARGET="$1"; shift
OWNER=""; REVIEWERS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2 ;;
    --reviewers) REVIEWERS="${2:-}"; shift 2 ;;
    --template) TEMPLATE="${2:-}"; shift 2 ;;
    *) die "알 수 없는 옵션: $1" ;;
  esac
done
[ ! -e "$TARGET" ] || die "이미 있는 경로다: $TARGET"
[ -f "$TEMPLATE/workspace.yaml" ] || die "템플릿 폴더에 workspace.yaml 이 없다: $TEMPLATE"

# 첫 커밋 작성자는 실행하는 사람의 git 설정을 쓴다. 메일을 지어내지 않는다:
# <이름>@users.noreply.github.com 같은 주소는 GitHub 에서 그 이름의 다른 사람 계정에 연결된다
AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git config user.name || true)}"
AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email || true)}"
[ -n "$AUTHOR_NAME" ] && [ -n "$AUTHOR_EMAIL" ] || die "커밋 작성자를 정할 수 없다. git config --global user.name / user.email 을 설정하거나 GIT_AUTHOR_NAME·GIT_AUTHOR_EMAIL 을 준다(GitHub 개인 noreply 메일 권장: GitHub Settings > Emails)"

mkdir -p "$TARGET"
cp -R "$TEMPLATE"/. "$TARGET"/
if [ -n "$REVIEWERS" ]; then
  printf '# 플로우 승인 권한자(PLAN 4.4, D10)\n/flows/ %s\n/testcases/ %s\n' "$REVIEWERS" "$REVIEWERS" > "$TARGET/CODEOWNERS"
elif [ -n "$OWNER" ]; then
  printf '# 플로우 승인 권한자(PLAN 4.4, D10). 팀 이름을 확인해 바꾼다\n/flows/ @%s/qa-leads\n/testcases/ @%s/qa-leads\n' "$OWNER" "$OWNER" > "$TARGET/CODEOWNERS"
fi

git -C "$TARGET" init -q -b main
git -C "$TARGET" add .
git -C "$TARGET" -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" commit -q -m "qa-workspace 템플릿"
echo "만들었다: $TARGET ($(git -C "$TARGET" rev-parse --short HEAD), 작성자 $AUTHOR_NAME <$AUTHOR_EMAIL>)"

cat <<GUIDE

다음은 조직 관리자가 한다(앱·스크립트가 하지 않음):
  1. 비공개 저장소 만들기와 푸시
       cd "$TARGET" && gh repo create ${OWNER:-<조직>}/qa-workspace --private --source . --push
  2. main 보호(Settings > Branches): PR 필수, 승인 1명 이상, CODEOWNERS 리뷰 필수, 강제 푸시 금지
  3. 팀원 권한: Write. 토큰은 fine-grained PAT(Contents·Pull requests 읽기·쓰기, Metadata 읽기, PLAN 10.2)
GUIDE
