# Lovable Bridge — Windows 安装器（PowerShell）
# 把 LovableBridge.exe 放到 %LOCALAPPDATA%\LovableBridge\，注册当前用户开机启动。
# 用法：双击“安装-双击这个.cmd”即可。
$ErrorActionPreference = "Stop"

$src    = Join-Path $PSScriptRoot "LovableBridge.exe"
$destDir = Join-Path $env:LOCALAPPDATA "LovableBridge"
$dest   = Join-Path $destDir "LovableBridge.exe"
$cfgDir = Join-Path $env:USERPROFILE ".lovable-trader"
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcut = Join-Path $startupDir "LovableBridge.lnk"

Get-Process LovableBridge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process bun -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*LovableBridge*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

function Copy-WithRetry($from, $to) {
  for ($i = 1; $i -le 5; $i++) {
    try { Copy-Item $from $to -Force; return } catch {
      if ($i -eq 5) { throw }
      Start-Sleep -Seconds 1
    }
  }
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
Copy-WithRetry $src $dest

try { Unregister-ScheduledTask -TaskName "LovableBridge" -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath = $dest
$lnk.WorkingDirectory = $destDir
$lnk.Save()

Start-Process -FilePath $dest -WorkingDirectory $destDir
Write-Host "✓ Lovable Bridge 已安装并启动。配置文件目录：$cfgDir"