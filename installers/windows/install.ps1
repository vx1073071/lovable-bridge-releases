# Lovable Bridge — Windows 安装器（PowerShell）
# 把 LovableBridge.exe 放到 %LOCALAPPDATA%\LovableBridge\，注册开机自启 Scheduled Task。
# 用法（管理员或当前用户均可）：powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"

$src    = Join-Path $PSScriptRoot "LovableBridge.exe"
$destDir = Join-Path $env:LOCALAPPDATA "LovableBridge"
$dest   = Join-Path $destDir "LovableBridge.exe"
$cfgDir = Join-Path $env:USERPROFILE ".lovable-trader"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
Copy-Item $src $dest -Force

# 注册当前用户登录后自启
$action  = New-ScheduledTaskAction -Execute $dest
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "LovableBridge" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName "LovableBridge"
Write-Host "✓ Lovable Bridge 已安装并启动。配置文件目录：$cfgDir"