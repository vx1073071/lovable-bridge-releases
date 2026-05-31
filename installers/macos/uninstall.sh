#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.lovable.bridge.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/Library/Application Support/LovableBridge"
echo "✓ Lovable Bridge 已卸载（配置文件 ~/.lovable-trader 保留）。"