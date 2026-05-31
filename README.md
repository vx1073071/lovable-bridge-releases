# Lovable Bridge (Futu)

本机守护进程,把 Lovable Cloud 的请求转发给本机 FutuOpenD。

## 首次发布到 GitHub Release（必读）

二进制托管在 **独立仓库** `vx1073071/lovable-bridge-releases`，与本 Lovable 项目分离。
在没有发布过 Release 前，前端 Step 2 的下载按钮会显示「安装包准备中」并禁用，
不会出现 404。完成下列步骤后下载按钮会自动激活：

1. 在 GitHub 上新建公开仓库 `vx1073071/lovable-bridge-releases`（空仓库即可）。
2. 把本项目的 `bridge/` 整个目录推到那个仓库的根目录（即 `bridge/index.ts` 落在仓库根的 `bridge/index.ts`）。
3. 在该仓库根目录创建 `.github/workflows/bridge-release.yml`，内容见 [bridge-release.yml 模板](#workflow-模板)。
4. 打 tag 并推送：`git tag bridge-v0.1.0 && git push --tags`，等 GitHub Actions 跑完，
   Release 会自动生成（含 `LovableBridge-*.zip/.tar.gz` 和 `latest.json`）。
5. 在本 Lovable 项目把 `src/routes/api/public/bridge/latest.ts` 的
   `RELEASE_PUBLISHED` 改为 `true`（或在部署环境设 `BRIDGE_RELEASE_PUBLISHED=1`）。

> 之后想发新版只需要重复第 4、5 步（更新版本号 + 打新 tag）。

### Workflow 模板

模板已经放在 `bridge/.github/workflows/bridge-release.yml`。
把 `bridge/` 整个目录复制到新仓库根目录时，记得**把 `bridge/.github` 整个文件夹挪到仓库根**
（GitHub Actions 只识别仓库根的 `.github/workflows/`）：

```bash
# 在新仓库根目录执行
mv bridge/.github .
git add .github bridge && git commit -m "init"
git tag bridge-v0.1.0 && git push --tags
```

## 架构

```
Lovable Cloud ──HTTPS poll──▶ Bridge(本机) ──TCP──▶ FutuOpenD(本机) ──▶ 富途
```

- 账号/解锁码/交易密码:**只存在 FutuOpenD 里**,Bridge 和 Cloud 都不接触。
- 默认只支持**模拟交易**(`TrdEnv.SIMULATE`)和**美股行情**。

## 配置

在浏览器打开 `/futu` 页面 → 第 3 步生成配对凭证 → 复制 JSON 到:

- macOS / Linux: `~/.lovable-trader/config.json`
- Windows: `%USERPROFILE%\.lovable-trader\config.json`

```json
{
  "cloudUrl": "https://<your-project>.lovable.app",
  "bridgeId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "opendHost": "127.0.0.1",
  "opendPort": 11111
}
```

## 运行(开发态)

```bash
# 可选：装 futu-api SDK，否则 Bridge 以 stub 模式运行（仅返回假数据，主循环可测）
npm i futu-api
bun run bridge/index.ts
```

## 打包成单文件可执行

用 Bun 的 `--compile` 输出单文件可执行（自带运行时，用户无需装 Node/Bun）：

```bash
# Windows x64
bun build --compile --target=bun-windows-x64 --outfile=dist/LovableBridge.exe bridge/index.ts
# macOS Apple Silicon
bun build --compile --target=bun-darwin-arm64 --outfile=dist/LovableBridge-mac-arm64 bridge/index.ts
# macOS Intel
bun build --compile --target=bun-darwin-x64 --outfile=dist/LovableBridge-mac-x64 bridge/index.ts
# Linux x64
bun build --compile --target=bun-linux-x64 --outfile=dist/LovableBridge-linux-x64 bridge/index.ts
```

## 打包 + 安装器（本轮交付）

- `bridge/scripts/build-all.sh`：一键产出 Windows / macOS arm64 / macOS x64 / Linux 四个单文件可执行。
- `bridge/installers/windows/install.ps1`：复制到 `%LOCALAPPDATA%\LovableBridge\`，注册 Scheduled Task 登录自启。
- `bridge/installers/macos/install.sh` + `com.lovable.bridge.plist`：复制到 `~/Library/Application Support/LovableBridge/`，加载 LaunchAgent 开机自启。
- `.github/workflows/bridge-release.yml`：打 tag `bridge-vX.Y.Z` 自动产出 zip/tar.gz 上传到 GitHub Release。
- `/api/public/bridge/latest`：返回当前最新版本号 + 各平台下载链接。前端 Step 2 拉它渲染按钮；Bridge 启动后每 6 小时拉一次提示更新。

## 自我替换式自动更新（本轮）

- `bridge/self-update.ts`：拉 `/api/public/bridge/latest`，比对版本 → 下载原始二进制 → sha256 校验 → 覆盖自身 → 退出，由 LaunchAgent / Scheduled Task 自动拉起新版。
- POSIX 走原子 `rename`；Windows 因为运行中 .exe 不可替换，下载到 `<exe>.new` 后 spawn 一个 cmd 脚本延迟覆盖 + `schtasks /run` 重启。
- Bridge 每 6 小时自检一次。

## 代码签名 / 公证（本轮，CI 就绪）

- Windows：`.github/workflows/bridge-release.yml` 里 `Sign Windows binary` 步骤，凭 `secrets.WIN_PFX_BASE64` + `WIN_PFX_PASSWORD`，用 osslsigncode 完成 Authenticode 签名。
- macOS：`macos-sign` job 在 macOS runner 上跑 `codesign --options runtime --timestamp` + `notarytool submit --wait`，凭 `MAC_CERT_BASE64` / `MAC_CERT_PASSWORD` / `MAC_DEV_ID` / `MAC_APPLE_ID` / `MAC_TEAM_ID` / `MAC_NOTARY_PWD`，仓库变量 `ENABLE_MAC_NOTARIZE=true` 才会触发。
- 没配 secrets 时步骤自动跳过，发布的是未签名版本（用户需手动放行）。

## 还没做（留下一轮）

- 真实账户、港股、A 股、Level2。
- 多 Bridge 路由（Durable Object，扩多实例时迁移）。

## 不做(MVP 边界)

- 多 Bridge 路由（扩多 Worker 实例时迁 Durable Object）