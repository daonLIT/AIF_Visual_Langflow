# Langflow 포크 프런트엔드를 고정 태그에서 다시 만든다: 체크아웃 → patches/ 적용 → npm ci → 빌드.
# AIF 화면(@aif/workbench)은 이 저장소의 packages/ 소스를 그대로 묶으므로, 저장소 루트의 npm 의존성도 필요하다.
# 결과: vendor/langflow-fork/src/frontend/build (start-langflow-p0.ps1 이 이 폴더를 화면으로 제공)
$ErrorActionPreference = 'Stop'
$Tag = 'v1.11.0'
$Commit = '562e5f2d6feeb52a28dfa647e63a1a620fcee334'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$fork = Join-Path $root 'vendor\langflow-fork'
$patches = Get-ChildItem (Join-Path $PSScriptRoot 'patches') -Filter *.patch | Sort-Object Name

# npm.ps1 은 호출 줄을 다시 해석하므로 함수 안에서는 npm.cmd 를 쓴다.
function Invoke-Native([string]$exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') 실패 ($LASTEXITCODE)" }
}

if (-not (Test-Path $fork)) {
  New-Item -ItemType Directory -Force (Split-Path $fork) | Out-Null
  Invoke-Native git @('clone', '--depth', '1', '--branch', $Tag, '--filter=blob:none', '--sparse',
    'https://github.com/langflow-ai/langflow.git', $fork)
  Invoke-Native git @('-C', $fork, 'sparse-checkout', 'set', 'src/frontend')
}

$head = (& git -C $fork rev-parse HEAD).Trim()
if ($head -ne $Commit) { throw "포크 HEAD 가 $Commit 이 아닙니다: $head" }

# 이미 적용된 패치는 건너뛰고, 원본과 어긋나면 멈춘다(작업 중 변경을 덮어쓰지 않음).
foreach ($p in $patches) {
  & git -C $fork apply --check -R $p.FullName 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host "적용됨: $($p.Name)"; continue }
  Invoke-Native git @('-C', $fork, 'apply', $p.FullName)
  Write-Host "적용: $($p.Name)"
}

# @aif/workbench 가 쓰는 zustand·elkjs 는 저장소 루트 node_modules 에서 온다(npm workspaces).
if (-not (Test-Path (Join-Path $root 'node_modules\zustand'))) {
  Push-Location $root
  try { Invoke-Native npm.cmd @('ci', '--no-audit', '--no-fund') } finally { Pop-Location }
}

$frontend = Join-Path $fork 'src\frontend'
Push-Location $frontend
try {
  if (-not (Test-Path 'node_modules')) { Invoke-Native npm.cmd @('ci', '--no-audit', '--no-fund') }
  $env:VITE_AIF_BUILD_MARK = "aif lf-$Tag@$($Commit.Substring(0, 7)) $((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))"
  Invoke-Native npm.cmd @('run', 'build')
  Set-Content -Encoding utf8 (Join-Path $frontend 'build\aif-build-mark.txt') $env:VITE_AIF_BUILD_MARK
  Write-Host "빌드 표식: $env:VITE_AIF_BUILD_MARK"
} finally {
  Pop-Location
}
