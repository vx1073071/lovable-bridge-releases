# Lovable Bridge v0.4.0

本机守护进程，转发 Cloud ↔ FutuOpenD。

## v0.4.0 新增能力

| Job kind            | 触发方                                                | Cloud 落库                 |
| ------------------- | ------------------------------------------------------ | -------------------------- |
| `kline`             | 任何前端拉 K 线（先查共享缓存，miss 时 Cloud 入队）   | `futu_klines` 共享缓存     |
| `equity_snapshot`   | `pg_cron`「equity-snapshot-daily」每日 22:00 UTC      | `futu_equity_snapshots`    |
| `cancel_all`        | Kill Switch（设置页 → 触发熔断）                      | `futu_alerts` 汇总通知     |

配合下列 Cloud 端定时器：

| Cron                       | 频率           | 说明                                                |
| -------------------------- | -------------- | --------------------------------------------------- |
| `strategy-engine-tick`     | 每分钟         | 评估 `futu_rules`，匹配则入队 `place_order` / `alert` |
| `alerts-engine-tick`       | 每分钟         | 评估 `futu_alert_rules`，匹配则写 `futu_alerts`     |
| `equity-snapshot-daily`    | 每日 22:00 UTC | 给在线 Bridge 入队 `equity_snapshot` 任务           |
| `alerts-email-fallback`    | 每分钟         | 10 分钟未确认的 alert → 邮件兜底（已有）            |

## 升级方式

1. 关闭运行中的 Bridge 进程。
2. 删除旧二进制，下载 v0.4.0 重新放回原位置（macOS：`~/.lovable-trader/`，Windows：安装目录）。
3. `config.json` 完全兼容，无需改动。
4. 启动新版本，监控页心跳出现且版本号变为 0.4.0 即升级成功。

## 构建

```bash
cd bridge-source
bun install
bun run build:all   # 产出 dist/LovableBridge.exe / LovableBridge-mac-arm64 等
```

## 发布到 lovable-bridge-releases

本目录是 Lovable 主仓内的 fact-based 暂存区，便于 AI 一处可见所有 Bridge 代码。
发布时把 `bridge-source/` 完整内容 push 到外部 `lovable-bridge-releases` 仓，并打 `v0.4.0` tag。
self-update 通过读取该仓 `latest.json` 自动分发新版本。