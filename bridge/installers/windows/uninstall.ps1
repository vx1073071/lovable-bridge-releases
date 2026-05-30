$ErrorActionPreference = "SilentlyContinue"
Unregister-ScheduledTask -TaskName "LovableBridge" -Confirm:$false
Stop-Process -Name "LovableBridge" -Force
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "LovableBridge")
Write-Host "✓ Lovable Bridge 已卸载（配置文件 ~/.lovable-trader 保留）。"