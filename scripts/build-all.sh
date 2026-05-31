#!/usr/bin/env bash
# Cross-compile Lovable Bridge for all 4 targets.
# 用法：cd bridge && bun run build:all
# 产物在 dist/，配合 .github/workflows/bridge-release.yml 自动上传到 GitHub Release。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

echo "▶ Windows x64"
bun build index.ts --compile --target=bun-windows-x64  -o dist/LovableBridge.exe

echo "▶ macOS Apple Silicon"
bun build index.ts --compile --target=bun-darwin-arm64 -o dist/LovableBridge-mac-arm64

echo "▶ macOS Intel"
bun build index.ts --compile --target=bun-darwin-x64  -o dist/LovableBridge-mac-x64

echo "▶ Linux x64"
bun build index.ts --compile --target=bun-linux-x64   -o dist/LovableBridge-linux-x64

echo "✓ done → $(ls -1 dist/)"