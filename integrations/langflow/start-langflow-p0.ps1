# P0 실험용 Langflow 서버: 포크 빌드를 화면으로 제공하고, 공식 Desktop 과 다른 포트·설정·DB 를 쓴다.
# 공식 Desktop 의 venv 에 있는 langflow 1.11.0 을 실행만 한다(설치본 파일은 바꾸지 않음).
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$profileDir = Join-Path $PSScriptRoot '.profile'
New-Item -ItemType Directory -Force (Join-Path $profileDir 'config'), (Join-Path $profileDir 'data') | Out-Null

$langflowExe = if ($env:AIF_LANGFLOW_EXE) { $env:AIF_LANGFLOW_EXE } else {
  Join-Path $env:LOCALAPPDATA 'com.LangflowDesktop\.langflow-venv\Scripts\langflow.exe'
}
$port = if ($env:AIF_LANGFLOW_PORT) { $env:AIF_LANGFLOW_PORT } else { '7870' }
$frontend = Join-Path $root 'vendor\langflow-fork\src\frontend\build'
if (-not (Test-Path (Join-Path $frontend 'index.html'))) { throw "포크 빌드가 없습니다: $frontend" }

$env:LANGFLOW_CONFIG_DIR = Join-Path $profileDir 'config'
$env:LANGFLOW_DATABASE_URL = 'sqlite:///' + ((Join-Path $profileDir 'data\database.db') -replace '\\', '/')
$env:LANGFLOW_AUTO_LOGIN = 'true'
$env:PYTHONUTF8 = '1'

# PowerShell 5.1 은 네이티브 프로그램의 stderr 경고를 오류로 바꾸므로, 서버 실행 전에는 Stop 을 해제한다.
$ErrorActionPreference = 'Continue'

& $langflowExe run --host 127.0.0.1 --port $port --no-open-browser --frontend-path $frontend *> (Join-Path $profileDir "langflow-$port.log")
