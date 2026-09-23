#!/usr/bin/env bash
# 서버를 켠 뒤 돌린다. 필요한 것이 떠 있는지 보고, 꺼져 있으면 올린다.
# 컨테이너는 restart: unless-stopped 라 Docker 가 뜨면 대개 알아서 살아난다. 이 스크립트는 그것까지 확인한다.
#
#   ./deploy/start.sh
#
# 상태만 보고 아무것도 건드리지 않으려면:
#   ./deploy/start.sh --check-only
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
ENV_FILE=deploy/.env
check_only=0
problems=0

for arg in "$@"; do
  case "$arg" in
    --check-only) check_only=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $arg" >&2; exit 2 ;;
  esac
done

ok()   { printf 'ok   %s\n' "$1"; }
warn() { printf 'FAIL %s\n' "$1"; problems=$((problems + 1)); }
step() { printf '\n=== %s ===\n' "$1"; }

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE 가 없다." >&2; exit 1; }
domain=$(grep '^AIF_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)

step "1/4 Docker"
if docker info >/dev/null 2>&1; then
  ok "Docker 가 돌고 있다"
else
  warn "Docker 가 꺼져 있다"
  if [ "$check_only" = 0 ] && command -v systemctl >/dev/null 2>&1; then
    echo "  시작한다: sudo systemctl start docker"
    sudo systemctl start docker && sleep 3
    docker info >/dev/null 2>&1 && ok "Docker 를 켰다" || { echo "  Docker 를 켜지 못했다. 직접 확인한다." >&2; exit 1; }
  else
    exit 1
  fi
fi

step "2/4 중앙 서버 컨테이너"
running=$("${COMPOSE[@]}" ps --status running --services 2>/dev/null || true)
if grep -qx aif <<<"$running" && grep -qx caddy <<<"$running"; then
  ok "aif·caddy 가 돌고 있다"
else
  warn "컨테이너가 다 떠 있지 않다 (지금: ${running:-없음})"
  if [ "$check_only" = 0 ]; then
    echo "  올린다: up -d --wait"
    # --wait: 헬스체크가 healthy 가 될 때까지 기다린다. 이미지는 있는 것을 쓴다(빌드하지 않는다).
    "${COMPOSE[@]}" up -d --wait && ok "컨테이너를 올렸다"
  fi
fi
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

step "3/4 바깥에서 닿는지"
# 컨테이너가 healthy 여도 포트·인증서가 어긋나면 사용자는 못 쓴다. 공개 주소로 확인한다.
https_port=$(grep '^AIF_HTTPS_PORT=' "$ENV_FILE" | cut -d= -f2- || true)
https_port=${https_port:-443}
url="https://$domain"
[ "$https_port" = 443 ] || url="https://$domain:$https_port"
# 로컬 시험(localhost)은 Caddy 내부 CA 라 인증서를 검사할 수 없다. 운영 도메인은 검사한다.
insecure=""
case "$domain" in localhost|127.0.0.1) insecure="-k" ;; esac
if [ -n "$domain" ] && curl -fsS $insecure -m 15 "$url/api/health" >/dev/null 2>&1; then
  ok "$url 응답"
else
  warn "${url:-(도메인 없음)} 에 닿지 않는다"
  echo "  포트·인증서를 본다: grep -E '^AIF_(DOMAIN|HTTP_PORT|HTTPS_PORT)=' $ENV_FILE"
  echo "  Caddy 로그      : ${COMPOSE[*]} logs --tail 30 caddy"
fi

step "4/4 Ollama"
# 중앙 서버는 Ollama 를 부르지 않는다(LANGFLOW_MODE=off). 사용자 PC 가 SSH 터널로 쓰므로 서버에서 떠 있어야 한다.
if curl -fsS -m 5 http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama 가 돌고 있다 (localhost:11434)"
else
  warn "Ollama 가 꺼져 있다 — 사용자 PC 에서 분석을 돌릴 수 없다"
  if [ "$check_only" = 0 ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
      echo "  시작한다: sudo systemctl start ollama"
      sudo systemctl start ollama && sleep 3
      curl -fsS -m 5 http://localhost:11434/api/tags >/dev/null 2>&1 && ok "Ollama 를 켰다" || echo "  아직 응답이 없다. 잠시 뒤 다시 확인한다." >&2
    else
      echo "  systemd 서비스가 없다. 설치한 방식대로 직접 켠다(예: ollama serve &)." >&2
    fi
  fi
fi

printf '\n'
if [ "$problems" = 0 ]; then
  echo "다 떠 있다."
else
  echo "확인이 필요한 항목 $problems 개. 위의 FAIL 줄을 본다."
  exit 1
fi
