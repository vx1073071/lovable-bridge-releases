#!/usr/bin/env bash
# Lovable Bridge — macOS 安装器
# 把二进制拷到 ~/Library/Application Support/LovableBridge/，注册 LaunchAgent 开机自启。
# 用法：bash install.sh [path-to-binary]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH="$(uname -m)"
if [ "$#" -ge 1 ]; then
  SRC="$1"
elif [ "$ARCH" = "arm64" ]; then
  SRC="$HERE/LovableBridge-mac-arm64"
else
  SRC="$HERE/LovableBridge-mac-x64"
fi

APP_DIR="$HOME/Library/Application Support/LovableBridge"
LOG_DIR="$HOME/Library/Logs/LovableBridge"
AGENT_DIR="$HOME/Library/LaunchAgents"
CFG_DIR="$HOME/.lovable-trader"
BIN="$APP_DIR/LovableBridge"
PLIST="$AGENT_DIR/com.lovable.bridge.plist"
LOG="$LOG_DIR/bridge.log"

mkdir -p "$APP_DIR" "$LOG_DIR" "$AGENT_DIR" "$CFG_DIR"
cp "$SRC" "$BIN"
chmod +x "$BIN"
# macOS Gatekeeper 隔离属性（未签名时手动放行；签名/公证留下一轮）
xattr -dr com.apple.quarantine "$BIN" 2>/dev/null || true

sed -e "s|__BIN_PATH__|$BIN|g" -e "s|__LOG_PATH__|$LOG|g" "$HERE/com.lovable.bridge.plist" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "✓ Lovable Bridge 已安装并启动。配置：$CFG_DIR  日志：$LOG"