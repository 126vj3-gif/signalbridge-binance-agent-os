$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot\..

# Use the local proxy when it is available; do not print credentials or tokens.
if (Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -InformationLevel Quiet -WarningAction SilentlyContinue) {
  $env:HTTP_PROXY = "http://127.0.0.1:7897"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"
  $env:ALL_PROXY = "http://127.0.0.1:7897"
  $env:NODE_USE_ENV_PROXY = "1"
}

npm run mcp:health
