# Bridge v0.2.1 升级步骤

这版修了 v0.2.0 的两个致命问题：
1. `futu-api` 真正打包进二进制（v0.2.0 是 optionalDependencies + 动态 import，bun --compile 不会带）
2. 调用 OpenD 的方法名/连接方式按真实 `futu-api` v10.x 重写（v0.2.0 用的是虚构 API，即便打包也跑不通）

## 发布到 GitHub Release

在你的 `vx1073071/lovable-bridge-releases` 仓库里：

```bash
# 1. 把这三个文件覆盖到 bridge/ 目录（self-update.ts / installers / scripts 不动）
cp bridge-source/package.json   path/to/lovable-bridge-releases/bridge/package.json
cp bridge-source/index.ts       path/to/lovable-bridge-releases/bridge/index.ts

# 2. 安装依赖并本地试跑
cd path/to/lovable-bridge-releases/bridge
rm -rf node_modules bun.lockb
bun install   # 或 npm install
bun run dev   # 应该看到 [Bridge] OpenD connected ...（前提 FutuOpenD 已启动）

# 3. 提交并打 tag，触发 GH Actions 构建发布
git add bridge/
git commit -m "bridge v0.2.1: real futu-api integration"
git tag bridge-v0.2.1
git push && git push --tags
```

CI 跑完会在 release 页面挂上新的 LovableBridge.exe / mac / linux 二进制和 latest.json，
已经装好的 Bridge 会通过 self-update 在 6 小时内自动升级；想立刻升级就重启一下任务。

## 真接通的前提

本机必须：
- 安装 **FutuOpenD**（富途官方网关）并已用富途账号登录
- `config.json` 里 `opendHost=127.0.0.1` `opendPort=11111`（默认即可）
- 如果要下真实单：在 `config.json` 加 `"unlockCode": "<交易密码的MD5>"`

模拟单（trdEnv=SIMULATE）不需要 unlockCode。