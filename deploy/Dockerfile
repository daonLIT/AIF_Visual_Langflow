# 중앙 AIF 서버 이미지: 웹(frontend/dist) + API 를 한 출처로 제공한다. Langflow·Ollama 는 들어 있지 않다(LANGFLOW_MODE=off).
# 빌드 (저장소 루트에서):  docker build -f deploy/Dockerfile -t aif-central .
# 데이터(DB·토큰·계정)는 /data 볼륨에만 쓴다. 이미지를 바꿔도 데이터는 남는다.

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY packages/aif-workbench/package.json packages/aif-workbench/package.json
RUN npm ci --no-audit --no-fund
COPY eslint.config.mjs ./
COPY packages packages
COPY frontend frontend
RUN npm run build -w frontend

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY backend/requirements.lock.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock.txt
COPY backend/app app
COPY backend/catalog catalog
COPY backend/scripts scripts
COPY --from=web /src/frontend/dist /app/web
RUN useradd --system --uid 10001 --home-dir /nonexistent aif && mkdir -p /data && chown aif:aif /data
USER aif

# 운영 기본값. 필요한 값은 compose 의 .env 로 덮어쓴다(deploy/.env.example).
ENV AIF_SKIP_DOTENV=1 \
    LANGFLOW_MODE=off \
    AIF_AUTH_MODE=token \
    AIF_WEB_DIST=/app/web \
    DATABASE_PATH=/data/annotation.sqlite3 \
    AIF_API_TOKENS_FILE=/data/api_tokens.json \
    AIF_USERS_FILE=/data/users.json \
    AIF_COOKIE_SECURE=auto

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)"
# 앞단 HTTPS 프록시(Caddy)가 붙인 X-Forwarded-Proto 를 믿어 https 로 본다(쿠키 Secure). 프록시만 이 컨테이너에 닿게 한다.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
