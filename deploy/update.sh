#!/usr/bin/env bash
# 운영 서버 업데이트: 코드 받기 → 백업 → 재배포 → 상태 확인.
# 서버에서 저장소 루트로 가서 실행한다.
#
#   ./deploy/update.sh                 # git pull 부터 전부
#   ./deploy/update.sh --no-pull       # 코드를 이미 올려 둔 경우(archive 사본 등)
#   ./deploy/update.sh --check         # 끝나고 smoke_check 까지 (아래 두 파일이 필요)
#                                      #   SMOKE_PASSWORD_FILE, SMOKE_PUBLISH_TOKEN_FILE
#
# 되돌리기: 끝에 출력되는 이전 이미지 태그와 백업 파일 이름을 쓴다.
# DB 마이그레이션은 컨테이너가 시작하면서 자동으로 하고, 그때 백업도 하나 더 만든다.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
ENV_FILE=deploy/.env
pull=1
check=0

for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=0 ;;
    --check) check=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n=== %s ===\n' "$1"; }

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE 가 없다. deploy/.env.example 을 복사해 채운다." >&2; exit 1; }

# 점검에 필요한 것은 배포를 시작하기 전에 확인한다(다 끝낸 뒤 파일이 없어 멈추지 않게).
if [ "$check" = 1 ]; then
  : "${SMOKE_PASSWORD_FILE:?--check 에는 SMOKE_PASSWORD_FILE 이 필요하다}"
  : "${SMOKE_PUBLISH_TOKEN_FILE:?--check 에는 SMOKE_PUBLISH_TOKEN_FILE 이 필요하다}"
  [ -f "$SMOKE_PASSWORD_FILE" ] || { echo "SMOKE_PASSWORD_FILE 이 없다: $SMOKE_PASSWORD_FILE" >&2; exit 1; }
  [ -f "$SMOKE_PUBLISH_TOKEN_FILE" ] || { echo "SMOKE_PUBLISH_TOKEN_FILE 이 없다: $SMOKE_PUBLISH_TOKEN_FILE" >&2; exit 1; }
fi

previous_tag=$(grep '^AIF_IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2- || true)
previous_commit=$(git rev-parse --short HEAD 2>/dev/null || echo "(git 아님)")

if [ "$pull" = 1 ]; then
  step "1/5 코드 받기"
  if [ ! -d .git ]; then
    cat >&2 <<'MSG'
이 폴더는 git 저장소가 아니다(archive 사본). 한 번만 clone 사본으로 바꾼다:

    cd ~ && mv aif-central aif-central.old
    git clone https://github.com/daonLIT/AIF_Visual_Langflow.git aif-central
    cp aif-central.old/deploy/.env aif-central/deploy/.env
    cp -r aif-central.old/deploy/backups aif-central/deploy/ 2>/dev/null || true

데이터는 Docker 볼륨(aif-data)에 있어 그대로 남는다. 옮긴 뒤 이 스크립트를 다시 실행한다.
MSG
    exit 1
  fi
  git pull --ff-only
else
  step "1/5 코드 받기 — 건너뜀(--no-pull)"
fi

commit=$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)

step "2/5 백업"
# 지금 돌고 있는(=바꾸기 전) 컨테이너에서 받는다. 컨테이너가 없으면 첫 배포이므로 건너뛴다.
if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx aif; then
  # MSYS_NO_PATHCONV: Windows Git Bash 에서 시험할 때 /backups 를 윈도 경로로 바꾸지 않게 한다(리눅스에서는 무시된다).
  MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T aif python scripts/backup_db.py --out-dir /backups --keep 14
else
  echo "aif 컨테이너가 돌고 있지 않다. 백업을 건너뛴다(첫 배포)."
fi

step "3/5 이미지 태그"
# 같은 날 두 번 배포해도 구분되도록 커밋을 붙인다. 되돌릴 때 이전 태그로 띄운다.
new_tag="$(date -u +%Y%m%d)-$commit"
sed -i "s/^AIF_IMAGE_TAG=.*/AIF_IMAGE_TAG=$new_tag/" "$ENV_FILE"
echo "$previous_tag → $new_tag"

step "4/5 재배포"
# --wait: 헬스체크가 healthy 가 될 때까지 기다린다(안 되면 0 이 아닌 값으로 끝난다).
"${COMPOSE[@]}" up -d --build --wait
"${COMPOSE[@]}" ps

if [ "$check" = 1 ]; then
  step "5/5 점검"
  domain=$(grep '^AIF_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)
  python_bin=$(command -v python3 || command -v python || true)
  [ -n "$python_bin" ] || { echo "python3 가 없어 점검을 돌리지 못했다(배포 자체는 끝났다)." >&2; exit 1; }
  "$python_bin" deploy/smoke_check.py --base "https://$domain" --user owner \
    --password-file "$SMOKE_PASSWORD_FILE" --publish-token-file "$SMOKE_PUBLISH_TOKEN_FILE"
else
  step "5/5 점검 — 건너뜀"
  echo "확인하려면: python3 deploy/smoke_check.py --base https://<도메인> --user owner \\"
  echo "              --password-file <파일> --publish-token-file <파일>"
fi

cat <<MSG

끝났다. 되돌리려면:
  sed -i 's/^AIF_IMAGE_TAG=.*/AIF_IMAGE_TAG=$previous_tag/' $ENV_FILE
  git checkout $previous_commit          # 코드도 되돌릴 때
  ${COMPOSE[*]} up -d --wait
DB 스키마가 바뀐 배포였다면 /backups 의 직전 백업으로 DB 도 함께 되돌린다
(새 스키마는 이전 코드가 모른다).
MSG
