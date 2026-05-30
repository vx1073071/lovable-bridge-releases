# Bridge 首次发布 Cheat Sheet

复制下面命令逐条执行。占位符只有一个：`<你的GitHub用户名>` 用 `dawnwhales`，`<TOKEN>` 用你在 GitHub 生成的 Personal Access Token（Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → 勾 `repo` → Generate → 复制）。

## 1. 在 GitHub 网页建空仓库

打开 https://github.com/new
- Owner: `dawnwhales`
- Repository name: `lovable-bridge-releases`
- Public
- **不要**勾 README / .gitignore / license
- 点 **Create repository**

## 2. 本机准备目录（任选一个空文件夹）

```bash
# macOS / Linux
mkdir -p ~/lovable-bridge-releases && cd ~/lovable-bridge-releases

# Windows PowerShell
mkdir $HOME\lovable-bridge-releases; cd $HOME\lovable-bridge-releases
```

## 3. 把 Lovable 项目里的 bridge/ 目录全部复制到这里

把本 Lovable 项目里 `bridge/` 文件夹（含里面所有文件，包括隐藏的 `.github/`）整份拷贝到上一步的目录里。结果应当是：

```
~/lovable-bridge-releases/
├── .github/workflows/bridge-release.yml   ← 必须在仓库根
├── index.ts
├── package.json
├── README.md
├── self-update.ts
├── installers/...
└── scripts/...
```

> **关键**：`.github` 必须在仓库根目录。如果拷贝后变成 `bridge/.github/...`，执行：
> ```bash
> mv bridge/.github . && mv bridge/* . && rmdir bridge
> ```

## 4. 初始化 git 并推送

```bash
git init
git branch -M main
git add .
git commit -m "init: lovable bridge v0.1.0"
git remote add origin https://github.com/dawnwhales/lovable-bridge-releases.git
git push -u origin main
```

推送时会要求登录：
- Username: `dawnwhales`
- Password: **粘贴 Personal Access Token**（不是 GitHub 登录密码）

## 5. 打 tag 触发自动构建

```bash
git tag bridge-v0.1.0
git push origin bridge-v0.1.0
```

## 6. 等 Actions 完成（2–5 分钟）

- 打开 https://github.com/dawnwhales/lovable-bridge-releases/actions
- 等最新一行变绿勾 ✓
- 打开 https://github.com/dawnwhales/lovable-bridge-releases/releases
- 看到 `bridge-v0.1.0` 带 4 个 zip/tar.gz + `latest.json` 就成功了

## 7. 回 Lovable 聊天框发一句「发好了」

我会把 `src/routes/api/public/bridge/latest.ts` 里的 `RELEASE_PUBLISHED` 改成 `true`，下载按钮立刻激活。

---

## 发后续版本（v0.1.1, v0.1.2 ...）

```bash
cd ~/lovable-bridge-releases
# 改代码后
git commit -am "fix: xxx"
git push
git tag bridge-v0.1.1
git push origin bridge-v0.1.1
```

同时让我把 Lovable 项目里 `src/routes/api/public/bridge/latest.ts` 的 `VERSION` 改成新版本号即可。

---

## 常见报错

| 现象 | 原因 | 处理 |
|---|---|---|
| Actions 标签里一直没有任何 workflow | `.github` 没放在仓库根 | 按第 3 步的 `mv` 命令修正后 `git add . && git commit --amend --no-edit && git push -f` |
| Actions 跑红了 | 看红色那一步的日志 | 把日志截图发我 |
| `git push` 报 `Permission denied` 或 `Authentication failed` | Token 没勾 `repo` 权限 / 用了登录密码 | 重新生成 token，确保勾 `repo` |
| `git push` 报 `remote: Repository not found` | 仓库没建 / owner 拼错 | 回第 1 步检查 |
| Release 里没有 `latest.json` | workflow 没跑完 / 跑红了 | 看 Actions 日志 |
