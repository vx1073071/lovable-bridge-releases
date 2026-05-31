#!/usr/bin/env bash
# Cross-compile Lovable Bridge for all 4 targets.
# 用法：cd bridge && bun run build:all
# 产物在 dist/，配合 .github/workflows/bridge-release.yml 自动上传到 GitHub Release。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

echo "▶ Installing deps (includes futu-api → embedded in binary)"
bun install --frozen-lockfile 2>/dev/null || bun install

echo "▶ Windows x64"
bun build --compile --target=bun-windows-x64  --outfile=dist/LovableBridge.exe index.ts

echo "▶ macOS Apple Silicon"
bun build --compile --target=bun-darwin-arm64 --outfile=dist/LovableBridge-mac-arm64 index.ts

echo "▶ macOS Intel"
bun build --compile --target=bun-darwin-x64  --outfile=dist/LovableBridge-mac-x64 index.ts

echo "▶ Linux x64"
bun build --compile --target=bun-linux-x64   --outfile=dist/LovableBridge-linux-x64 index.ts

echo "✓ done → $(ls -1 dist/)"