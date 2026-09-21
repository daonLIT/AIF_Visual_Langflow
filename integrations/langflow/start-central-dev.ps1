# 로컬 통합 테스트용 중앙 AIF 서버: 토큰 인증 켜고, 개발 DB(backend/data) 대신 .profile/central 의 DB·토큰 파일을 쓴다.
# 운영 배포는 이 스크립트가 아니라 배포 문서의 환경변수로 띄운다(P4).
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$central = Join-Path $PSScriptRoot '.profile\central'
New-Item -ItemType Directory -Force $central | Out-Null

$env:AIF_SKIP_DOTENV = '1'          # 개발자 .env(live Langflow 설정)를 읽지 않는다. 중앙 서버는 Langflow 없이 동작한다.
$env:LANGFLOW_MODE = 'mock'
$env:AIF_AUTH_MODE = 'token'
$env:DATABASE_PATH = Join-Path $central 'aif-central.sqlite3'
$env:AIF_API_TOKENS_FILE = Join-Path $central 'api_tokens.json'
$env:AIF_USERS_FILE = Join-Path $central 'users.json'
if (-not $env:AIF_PUBLIC_SITE_URL) { $env:AIF_PUBLIC_SITE_URL = 'http://localhost:5173' }
$port = if ($env:AIF_CENTRAL_PORT) { $env:AIF_CENTRAL_PORT } else { '8000' }

Set-Location (Join-Path $root 'backend')
$ErrorActionPreference = 'Continue'
& python -m uvicorn app.main:app --host 127.0.0.1 --port $port *> (Join-Path $central "central-$port.log")
