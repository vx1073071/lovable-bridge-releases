/**
 * 自我替换式自动更新。
 * - POSIX (macOS/Linux)：下载 → 校验 sha256 → 原子 rename 覆盖当前可执行 → exit；
 *   LaunchAgent (KeepAlive) / systemd 会自动拉起新版。
 * - Windows：运行中的 .exe 无法被替换。下载到 `<exe>.new` → 校验 → spawn 一个 cmd：
 *   等几秒、覆盖、用 schtasks 重启 LovableBridge → 自身 exit。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Manifest = {
  version: string;
  assets: Record<string, string>;
  binaries?: Record<string, { url: string; sha256: string }>;
};

export function platformKey(): string {
  if (process.platform === "win32") return "windows-x64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  return "linux-x64";
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Returns true if an update was applied and the process should exit. */
export async function applyUpdate(cloudUrl: string, currentVersion: string): Promise<boolean> {
  const res = await fetch(`${cloudUrl}/api/public/bridge/latest`);
  if (!res.ok) return false;
  const m = (await res.json()) as Manifest;
  if (!m.version || m.version === currentVersion) return false;
  const key = platformKey();
  const entry = m.binaries?.[key];
  if (!entry) {
    // 还没发布原始二进制（只有 zip），只提示
    console.log(`[Bridge] 有新版本 ${m.version}（当前 ${currentVersion}），下载：${m.assets[key]}`);
    return false;
  }

  console.log(`[Bridge] 下载新版本 ${m.version} …`);
  const buf = await download(entry.url);
  const got = sha256(buf);
  if (entry.sha256 && got !== entry.sha256) {
    throw new Error(`sha256 mismatch: expected ${entry.sha256}, got ${got}`);
  }

  const self = process.execPath;
  if (process.platform === "win32") {
    const staged = `${self}.new`;
    writeFileSync(staged, buf);
    const swap = join(tmpdir(), `lovable-bridge-swap-${Date.now()}.cmd`);
    writeFileSync(
      swap,
      [
        "@echo off",
        "timeout /t 3 /nobreak >nul",
        `move /Y "${staged}" "${self}" >nul`,
        `schtasks /run /tn LovableBridge >nul 2>&1`,
        `del "%~f0"`,
      ].join("\r\n"),
    );
    spawn("cmd.exe", ["/c", swap], { detached: true, stdio: "ignore" }).unref();
  } else {
    const staged = `${self}.new`;
    writeFileSync(staged, buf);
    chmodSync(staged, 0o755);
    // POSIX：rename 原子覆盖；正在运行的进程仍持有旧 inode，安全。
    renameSync(staged, self);
  }
  console.log(`[Bridge] 已写入新版本，退出由守护(launchd / Scheduled Task)拉起新版。`);
  return true;
}