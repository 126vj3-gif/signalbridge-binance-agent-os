$root = $PSScriptRoot
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*$root*run-paper.ps1*" -or $_.CommandLine -like "*$root*src\\index.mjs*" -or $_.CommandLine -like "*$root*npm-cli.js run analyze*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output "paper bot stopped"
