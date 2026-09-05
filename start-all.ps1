$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath .\config.json)) { Copy-Item -LiteralPath .\config.example.json -Destination .\config.json }
if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -InformationLevel Quiet)) { throw "Local proxy 127.0.0.1:7897 is unavailable" }
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:ALL_PROXY = "http://127.0.0.1:7897"
$env:NODE_USE_ENV_PROXY = "1"
$dataDir = Join-Path $PSScriptRoot "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$bridgeLog = Join-Path $dataDir "bridge.log"
$bridgeErr = Join-Path $dataDir "bridge.err.log"
$paperLog = Join-Path $dataDir "paper-run.log"
$paperErr = Join-Path $dataDir "paper-run.err.log"
$analysisLog = Join-Path $dataDir "analysis-run.log"
$analysisErr = Join-Path $dataDir "analysis-run.err.log"
Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command', "Set-Location -LiteralPath '$PSScriptRoot'; npm run bridge *>> '$bridgeLog' 2>> '$bridgeErr'" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command', "Set-Location -LiteralPath '$PSScriptRoot'; npm run paper *>> '$paperLog' 2>> '$paperErr'" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command', "Set-Location -LiteralPath '$PSScriptRoot'; npm run analyze *>> '$analysisLog' 2>> '$analysisErr'" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Write-Output "signal bridge, local analyzer, and paper executor started"
