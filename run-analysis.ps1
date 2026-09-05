param([switch]$Once)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .\config.json)) { Copy-Item .\config.example.json .\config.json }
if (Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -InformationLevel Quiet) {
  $env:HTTP_PROXY = "http://127.0.0.1:7897"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"
  $env:ALL_PROXY = "http://127.0.0.1:7897"
  $env:NODE_USE_ENV_PROXY = "1"
}
if ($Once) { npm run analyze -- --once }
else { npm run analyze }
