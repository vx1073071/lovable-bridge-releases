/**
 * Lovable Bridge v0.4.0 — runs on the user's machine.
 * Polls Lovable Cloud for jobs, forwards them to local FutuOpenD, posts results back.
 *
 * 真实接入 futu-api（v10.x）。自动探测 OpenD WebSocket 端口（GUI 版 33333，命令行版 11111），
 * 不需要用户手动改 config.json 的端口。
 *
 * 0.4.0 新增 job kinds：
 *   - kline           拉取标准化 K 线 → Cloud 端写 futu_klines 共享缓存
 *   - equity_snapshot 全账户净值快照（每日 pg_cron 触发）→ futu_equity_snapshots
 *   - cancel_all      撤销账户全部未成交订单（Kill Switch 联动）
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { applyUpdate } from "./self-update";
// futu-api 走懒加载：bun --compile 对它的 protobuf/ws 兼容性不稳，
// 顶层 import 会让 exe 启动即崩。这里 try-catch，加载失败就用 stub。
let ftWebsocket: any = null;
let ftLoadError: string | null = null;
let futuProtoRoot: any = null;
try {
  // @ts-ignore — futu-api 没有 d.ts
  ftWebsocket = require("futu-api");
  if (ftWebsocket?.default) ftWebsocket = ftWebsocket.default;
  futuProtoRoot = require("futu-api/proto.js");
  if (futuProtoRoot?.default) futuProtoRoot = futuProtoRoot.default;
} catch (e) {
  ftLoadError = (e as Error).message;
}

type Config = {
  cloudUrl: string;
  bridgeId: string;
  token: string;
  opendHost?: string;
  opendPort?: number;
  opendSsl?: boolean;
  opendKey?: string;
  unlockCode?: string; // MD5 形式的交易解锁码
};

const CONFIG_DIR = join(homedir(), ".lovable-trader");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConfig(): Promise<Config> {
  mkdirSync(CONFIG_DIR, { recursive: true });
  while (!existsSync(CONFIG_PATH)) {
    console.log(`[Bridge] 等待配置文件：${CONFIG_PATH}`);
    console.log("[Bridge] 先在网页 /futu 生成配对凭证，下载 config.json 后放到上面这个位置；本程序会自动继续，不会闪退。");
    await sleep(5000);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
}

let cfg: Config;
let OPEND_HOST = "127.0.0.1";
let OPEND_PORT = 11111;
let OPEND_SSL = false;
let OPEND_KEY = "";
const CURRENT_VERSION = "0.4.0";
// 优先走富途官方默认 API 端口 11111；如果用户启用了 WebSocket，再自动尝试 33333/11111。
// 这样不需要用户改 OpenD 配置，也不会依赖 WebSocket 密钥。
const TCP_PORT_CANDIDATES = [11111, 33333];
const WS_PORT_CANDIDATES = [33333, 11111];

async function checkForUpdate() {
  if (process.execPath.toLowerCase().endsWith("bun.exe") || process.execPath.toLowerCase().endsWith("bun")) {
    return;
  }
  try {
    const applied = await applyUpdate(cfg.cloudUrl, CURRENT_VERSION);
    if (applied) process.exit(0);
  } catch (e) {
    console.warn("[Bridge] update check failed:", (e as Error).message);
  }
}

// ───────── OpenD 连接（单连接，惰性建立） ─────────
let ws: any = null;
let loginPromise: Promise<void> | null = null;
let tradeUnlocked = false;

const FUTU_CMD: Record<string, { cmd: number; name: string }> = {
  InitConnect: { cmd: 1001, name: "InitConnect" },
  QotSub: { cmd: 3001, name: "Qot_Sub" },
  QotGetBasicQot: { cmd: 3004, name: "Qot_GetBasicQot" },
  QotGetOrderBook: { cmd: 3012, name: "Qot_GetOrderBook" },
  QotGetKL: { cmd: 3006, name: "Qot_GetKL" },
  TrdGetAccList: { cmd: 2001, name: "Trd_GetAccList" },
  TrdUnlockTrade: { cmd: 2005, name: "Trd_UnlockTrade" },
  TrdGetFunds: { cmd: 2101, name: "Trd_GetFunds" },
  TrdGetPositionList: { cmd: 2102, name: "Trd_GetPositionList" },
  TrdGetOrderList: { cmd: 2201, name: "Trd_GetOrderList" },
  TrdPlaceOrder: { cmd: 2202, name: "Trd_PlaceOrder" },
  TrdModifyOrder: { cmd: 2205, name: "Trd_ModifyOrder" },
};

class FutuTcpClient {
  private socket: Socket | null = null;
  private serial = 1000;
  private connID = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  async start(host: string, port: number) {
    if (!futuProtoRoot) throw new Error(`futu-api 协议文件未加载（${ftLoadError ?? "unknown"}）`);
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host, port });
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`port ${port} timeout`)); }, 4000);
      s.once("connect", () => { clearTimeout(timer); resolve(s); });
      s.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => this.rejectAll(new Error("OpenD 连接已断开")));
    const res = await this.send(FUTU_CMD.InitConnect, {
      c2s: {
        clientVer: 106,
        clientID: `LovableBridge-${cfg.bridgeId}`,
        recvNotify: true,
        packetEncAlgo: -1,
        pushProtoFmt: 0,
        programmingLanguage: "JavaScript",
      },
    }, 10000);
    this.connID = Number(res?.s2c?.connID ?? 0);
  }

  getConnID() { return this.connID; }
  close() { this.socket?.destroy(); this.rejectAll(new Error("OpenD 连接已关闭")); }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 44) {
      if (this.buffer.subarray(0, 2).toString() !== "FT") {
        this.rejectAll(new Error("OpenD 返回了无法识别的数据"));
        this.socket?.destroy();
        return;
      }
      const serial = this.buffer.readUInt32LE(8);
      const bodyLen = this.buffer.readUInt32LE(12);
      if (this.buffer.length < 44 + bodyLen) return;
      const body = this.buffer.subarray(44, 44 + bodyLen);
      this.buffer = this.buffer.subarray(44 + bodyLen);
      const item = this.pending.get(serial);
      if (item) {
        clearTimeout(item.timer);
        this.pending.delete(serial);
        item.resolve(body);
      }
    }
  }

  private rejectAll(error: Error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  async send(cmd: { cmd: number; name: string }, req: Record<string, unknown>, timeout = 5000) {
    if (!this.socket) throw new Error("OpenD 连接未建立");
    const Request = futuProtoRoot.lookup(`${cmd.name}.Request`);
    const Response = futuProtoRoot.lookup(`${cmd.name}.Response`);
    const body = Buffer.from(Request.encode(Request.create(req)).finish());
    const serial = ++this.serial;
    const header = Buffer.alloc(44);
    header.write("FT", 0, "ascii");
    header.writeUInt32LE(cmd.cmd, 2);
    header.writeUInt8(0, 6);
    header.writeUInt8(0, 7);
    header.writeUInt32LE(serial, 8);
    header.writeUInt32LE(body.length, 12);
    createHash("sha1").update(body).digest().copy(header, 16);
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(serial); reject(new Error(`${cmd.name} timeout`)); }, timeout);
      this.pending.set(serial, { resolve, reject, timer });
      this.socket!.write(Buffer.concat([header, body]));
    });
    const decoded = Response.decode(raw);
    if (decoded?.retType !== 0) throw new Error(decoded?.retMsg ?? `${cmd.name} failed`);
    return decoded;
  }

  Sub(req: Record<string, unknown>) { return this.send(FUTU_CMD.QotSub, req); }
  GetBasicQot(req: Record<string, unknown>) { return this.send(FUTU_CMD.QotGetBasicQot, req); }
  GetOrderBook(req: Record<string, unknown>) { return this.send(FUTU_CMD.QotGetOrderBook, req); }
  GetAccList(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdGetAccList, req); }
  UnlockTrade(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdUnlockTrade, req); }
  GetFunds(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdGetFunds, req); }
  GetPositionList(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdGetPositionList, req); }
  GetOrderList(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdGetOrderList, req); }
  PlaceOrder(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdPlaceOrder, req); }
  ModifyOrder(req: Record<string, unknown>) { return this.send(FUTU_CMD.TrdModifyOrder, req); }
  GetKL(req: Record<string, unknown>) { return this.send(FUTU_CMD.QotGetKL, req); }
}

async function tryConnectTcpOnce(port: number): Promise<void> {
  const candidate = new FutuTcpClient();
  await candidate.start(OPEND_HOST, port);
  ws = candidate;
  OPEND_PORT = port;
  console.log(`[Bridge] OpenD TCP connected at ${OPEND_HOST}:${port}`);
}

function tryConnectOnce(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!ftWebsocket) {
      reject(new Error(`futu-api 未加载（${ftLoadError ?? "unknown"}）`));
      return;
    }
    try {
      const candidate = new ftWebsocket();
      const timer = setTimeout(() => {
        try { candidate.close?.(); } catch {}
        reject(new Error(`port ${port} timeout`));
      }, 4000);
      candidate.onlogin = (ret: number | boolean, msg: string) => {
        clearTimeout(timer);
        if (ret === 0 || ret === true) {
          ws = candidate;
          OPEND_PORT = port;
          console.log(`[Bridge] OpenD WebSocket connected at ${OPEND_HOST}:${port}`);
          resolve();
        } else {
          try { candidate.close?.(); } catch {}
          reject(new Error(`port ${port} login failed: ret=${ret} ${msg}`));
        }
      };
      candidate.start(OPEND_HOST, port, OPEND_SSL, OPEND_KEY);
    } catch (e) {
      reject(e as Error);
    }
  });
}

function connect(): Promise<void> {
  if (loginPromise) return loginPromise;
  const tcpOrder = Array.from(new Set([
    ...(cfg.opendPort ? [cfg.opendPort] : []),
    ...TCP_PORT_CANDIDATES,
  ]));
  const wsOrder = Array.from(new Set([
    ...(cfg.opendPort ? [cfg.opendPort] : []),
    ...WS_PORT_CANDIDATES,
  ]));
  loginPromise = (async () => {
    const errors: string[] = [];
    for (const p of tcpOrder) {
      try {
        await tryConnectTcpOnce(p);
        return;
      } catch (e) {
        errors.push(`TCP ${p}: ${(e as Error).message}`);
      }
    }
    for (const p of wsOrder) {
      try {
        await tryConnectOnce(p);
        return;
      } catch (e) {
        errors.push(`WebSocket ${p}: ${(e as Error).message}`);
      }
    }
    throw new Error(
      `无法连接 FutuOpenD。Bridge 已自动试过富途默认 API 端口 ${tcpOrder.join("/")}，也试过 WebSocket 端口 ${wsOrder.join("/")}。请确认 FutuOpenD 已启动并已登录。详情：${errors.join(" | ")}`,
    );
  })().catch((e) => {
    loginPromise = null;
    ws = null;
    throw e;
  });
  return loginPromise;
}

async function getCtx() {
  await connect();
  return ws;
}

async function unlockTradeIfNeeded() {
  if (tradeUnlocked) return;
  if (!cfg.unlockCode) return; // 模拟单不需要
  const ctx = await getCtx();
  const res = await ctx.UnlockTrade({ c2s: { unlock: true, pwdMD5: cfg.unlockCode } });
  if (res?.retType !== 0) throw new Error(`UnlockTrade failed: ${res?.retMsg ?? "unknown"}`);
  tradeUnlocked = true;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${cfg.cloudUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": cfg.token },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<any>;
}

async function heartbeat() {
  try {
    await post("/api/public/futu/heartbeat", { bridgeId: cfg.bridgeId, os: process.platform });
  } catch (e) {
    console.warn("[Bridge] heartbeat failed:", (e as Error).message);
  }
}

// ───────── 协议常量（来自富途 proto） ─────────
// Qot_Common.QotMarket: 1=HK 11=US 21=SH 22=SZ
const MARKET_ENUM: Record<string, number> = { HK: 1, US: 11, SH: 21, SZ: 22 };
// Qot_Common.SubType: 1=BASIC 2=ORDER_BOOK 4=TICKER 14=BROKER
const L1_SUBS = [1];
const L2_SUBS = [1, 2];

function trdEnvCode(v: unknown) { return v === "REAL" ? 1 : 0; } // 0=SIMULATE 1=REAL
function marketCode(code: string) { return MARKET_ENUM[code.split(".")[0].toUpperCase()] ?? 11; }
function symOf(code: string) { return code.split(".")[1]; }

// Qot_Common.KLType: 1=1Min 2=Day 3=Week 4=Month 6=5Min 7=15Min 8=30Min 9=60Min
const KL_TYPE: Record<string, number> = {
  "1m": 1, "5m": 6, "15m": 7, "30m": 8, "60m": 9, "1h": 9,
  "1d": 2, "day": 2, "1w": 3, "1M": 4,
};
const REHAB_DEFAULT = 1; // 1=Forward 复权

async function callOpenD(kind: string, payload: Record<string, unknown>): Promise<unknown> {
  const ctx = await getCtx();

  switch (kind) {
    case "quote": {
      const code = String(payload.code);
      const security = { market: marketCode(code), code: symOf(code) };
      const subs = payload.level === "L2" ? L2_SUBS : L1_SUBS;
      await ctx.Sub({ c2s: { securityList: [security], subTypeList: subs, isSubOrUnSub: true, isRegOrUnRegPush: false } });
      const res = await ctx.GetBasicQot({ c2s: { securityList: [security] } });
      const q = res?.s2c?.basicQotList?.[0];
      let orderBook: unknown = null;
      if (payload.level === "L2") {
        const ob = await ctx.GetOrderBook({ c2s: { security, num: 10 } });
        orderBook = { bid: ob?.s2c?.orderBookBidList ?? [], ask: ob?.s2c?.orderBookAskList ?? [] };
      }
      return {
        code,
        level: payload.level ?? "L1",
        last: q?.curPrice ?? 0,
        bid: q?.bidPrice ?? null,
        ask: q?.askPrice ?? null,
        orderBook,
        ts: new Date().toISOString(),
      };
    }

    case "list_accounts": {
      const trdEnv = trdEnvCode(payload.trdEnv);
      const res = await ctx.GetAccList({ c2s: { userID: 0 } });
      return (res?.s2c?.accList ?? [])
        .filter((a: any) => a.trdEnv === trdEnv)
        .map((a: any) => ({
          accId: String(a.accID),
          trdEnv: payload.trdEnv,
          market: Object.keys(MARKET_ENUM).find((k) => MARKET_ENUM[k] === a.trdMarketAuthList?.[0]) ?? "US",
          accType: a.accType,
        }));
    }

    case "positions": {
      await unlockTradeIfNeeded();
      const res = await ctx.GetPositionList({
        c2s: {
          header: {
            trdEnv: trdEnvCode(payload.trdEnv),
            accID: Number(payload.accId),
            trdMarket: MARKET_ENUM[String(payload.market).toUpperCase()] ?? 11,
          },
        },
      });
      return (res?.s2c?.positionList ?? []).map((p: any) => ({
        code: p.code,
        qty: p.qty,
        canSellQty: p.canSellQty,
        costPrice: p.costPrice,
        marketVal: p.marketVal,
        plRatio: p.plRatio,
      }));
    }

    case "funds": {
      await unlockTradeIfNeeded();
      const res = await ctx.GetFunds({
        c2s: {
          header: {
            trdEnv: trdEnvCode(payload.trdEnv),
            accID: Number(payload.accId),
            trdMarket: MARKET_ENUM[String(payload.market).toUpperCase()] ?? 11,
          },
        },
      });
      const f = res?.s2c?.funds;
      return {
        cash: f?.cash,
        power: f?.power,
        totalAssets: f?.totalAssets,
        marketVal: f?.marketVal,
        currency: f?.currency,
      };
    }

    case "place_order": {
      const code = String(payload.code);
      await unlockTradeIfNeeded();
      const res = await ctx.PlaceOrder({
        c2s: {
          packetID: { connID: ws.getConnID?.() ?? 0, serialNo: Date.now() },
          header: {
            trdEnv: trdEnvCode(payload.trdEnv),
            accID: Number(payload.accId),
            trdMarket: marketCode(code),
          },
          trdSide: payload.side === "BUY" ? 1 : 2, // 1=BUY 2=SELL
          orderType: payload.orderType === "MARKET" ? 5 : 1, // 1=NORMAL限价 5=MARKET
          code: symOf(code),
          qty: Number(payload.qty),
          price: payload.price ? Number(payload.price) : 0,
          secMarket: marketCode(code),
        },
      });
      return {
        orderId: String(res?.s2c?.orderID ?? ""),
        status: res?.retType === 0 ? "submitted" : "rejected",
        retMsg: res?.retMsg ?? null,
      };
    }

    case "cancel_order": {
      await unlockTradeIfNeeded();
      const res = await ctx.ModifyOrder({
        c2s: {
          packetID: { connID: ws.getConnID?.() ?? 0, serialNo: Date.now() },
          header: {
            trdEnv: trdEnvCode(payload.trdEnv),
            accID: Number(payload.accId),
            trdMarket: MARKET_ENUM[String(payload.market).toUpperCase()] ?? 11,
          },
          orderID: payload.orderId,
          modifyOrderOp: 1, // 1=CANCEL
        },
      });
      return { ok: res?.retType === 0, retMsg: res?.retMsg ?? null };
    }

    case "orders": {
      await unlockTradeIfNeeded();
      const res = await ctx.GetOrderList({
        c2s: {
          header: {
            trdEnv: trdEnvCode(payload.trdEnv),
            accID: Number(payload.accId),
            trdMarket: MARKET_ENUM[String(payload.market).toUpperCase()] ?? 11,
          },
        },
      });
      return (res?.s2c?.orderList ?? []).map((o: any) => ({
        orderId: String(o.orderID),
        code: o.code,
        side: o.trdSide === 1 ? "BUY" : "SELL",
        qty: o.qty,
        price: o.price,
        status: o.orderStatus,
        fillQty: o.fillQty,
        fillAvgPrice: o.fillAvgPrice,
        createTime: o.createTime,
      }));
    }

    case "kline": {
      const code = String(payload.code);
      const security = { market: marketCode(code), code: symOf(code) };
      const ktype = String(payload.ktype ?? "1d");
      const klType = KL_TYPE[ktype] ?? 2;
      const reqNum = Math.min(Number(payload.num ?? 120), 1000);
      // OpenD 要求先订阅再查询
      await ctx.Sub({
        c2s: {
          securityList: [security],
          subTypeList: [3], // 3=KL
          isSubOrUnSub: true,
          isRegOrUnRegPush: false,
        },
      });
      const res = await ctx.GetKL({
        c2s: { rehabType: REHAB_DEFAULT, klType, security, reqNum },
      });
      const bars = (res?.s2c?.klList ?? []).map((k: any) => ({
        time: k.time,
        timestamp: k.timestamp,
        open: k.openPrice,
        high: k.highPrice,
        low: k.lowPrice,
        close: k.closePrice,
        volume: k.volume,
        turnover: k.turnover,
      }));
      return { code, ktype, bars, ts: new Date().toISOString() };
    }

    case "equity_snapshot": {
      await unlockTradeIfNeeded().catch(() => undefined);
      const inputAccounts = Array.isArray(payload.accounts)
        ? (payload.accounts as Array<{ accId: string; trdEnv: string; market: string }>)
        : [];
      const accounts =
        inputAccounts.length > 0
          ? inputAccounts
          : await (async () => {
              const accRes = await ctx.GetAccList({ c2s: { userID: 0 } });
              return (accRes?.s2c?.accList ?? [])
                .filter((a: any) => a.trdEnv === 0)
                .map((a: any) => ({
                  accId: String(a.accID),
                  trdEnv: "SIMULATE" as const,
                  market:
                    Object.keys(MARKET_ENUM).find((k) => MARKET_ENUM[k] === a.trdMarketAuthList?.[0]) ?? "US",
                }));
            })();
      const snapshots: any[] = [];
      for (const acc of accounts) {
        try {
          const fRes = await ctx.GetFunds({
            c2s: {
              header: {
                trdEnv: trdEnvCode(acc.trdEnv),
                accID: Number(acc.accId),
                trdMarket: MARKET_ENUM[acc.market?.toUpperCase()] ?? 11,
              },
            },
          });
          const f = fRes?.s2c?.funds;
          snapshots.push({
            accId: acc.accId,
            trdEnv: acc.trdEnv,
            market: acc.market,
            totalAssets: Number(f?.totalAssets ?? 0),
            cash: Number(f?.cash ?? 0),
            marketVal: Number(f?.marketVal ?? 0),
            currency: f?.currency ?? null,
          });
        } catch (e) {
          snapshots.push({
            accId: acc.accId,
            trdEnv: acc.trdEnv,
            market: acc.market,
            error: (e as Error).message,
          });
        }
      }
      return { snapshots, ts: new Date().toISOString() };
    }

    case "cancel_all": {
      await unlockTradeIfNeeded().catch(() => undefined);
      const trdMarket = MARKET_ENUM[String(payload.market ?? "US").toUpperCase()] ?? 11;
      const header = {
        trdEnv: trdEnvCode(payload.trdEnv),
        accID: Number(payload.accId),
        trdMarket,
      };
      const list = await ctx.GetOrderList({ c2s: { header } });
      const orders = (list?.s2c?.orderList ?? []) as any[];
      const OPEN_STATUSES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
      const openOrders = orders.filter((o) => OPEN_STATUSES.has(Number(o.orderStatus)));
      const results: Array<{ orderId: string; ok: boolean; retMsg?: string }> = [];
      for (const o of openOrders) {
        try {
          const r = await ctx.ModifyOrder({
            c2s: {
              packetID: { connID: ws.getConnID?.() ?? 0, serialNo: Date.now() },
              header,
              orderID: o.orderID,
              modifyOrderOp: 1,
            },
          });
          results.push({
            orderId: String(o.orderID),
            ok: r?.retType === 0,
            retMsg: r?.retMsg ?? undefined,
          });
        } catch (e) {
          results.push({ orderId: String(o.orderID), ok: false, retMsg: (e as Error).message });
        }
      }
      return {
        cancelled: results.filter((r) => r.ok).length,
        attempted: results.length,
        results,
      };
    }

    default:
      throw new Error(`Unknown kind: ${kind}`);
  }
}

async function pollOnce() {
  const { job } = (await post("/api/public/futu/jobs/poll", { bridgeId: cfg.bridgeId })) as {
    job: { id: string; kind: string; payload: Record<string, unknown> } | null;
  };
  if (!job) return;
  console.log(`[Bridge] job ${job.id} kind=${job.kind}`);
  try {
    const result = await callOpenD(job.kind, job.payload);
    await post("/api/public/futu/jobs/complete", { bridgeId: cfg.bridgeId, jobId: job.id, result });
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[Bridge] job ${job.id} failed: ${msg}`);
    await post("/api/public/futu/jobs/complete", { bridgeId: cfg.bridgeId, jobId: job.id, error: msg });
  }
}

async function mainLoop() {
  cfg = await loadConfig();
  OPEND_HOST = cfg.opendHost ?? "127.0.0.1";
  OPEND_PORT = cfg.opendPort ?? 11111;
  OPEND_SSL = cfg.opendSsl ?? false;
  OPEND_KEY = cfg.opendKey ?? "";
  console.log(`[Bridge] starting ${CURRENT_VERSION}, bridgeId=${cfg.bridgeId}, cloud=${cfg.cloudUrl}`);

  await heartbeat();
  setInterval(heartbeat, 15_000);
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce();
    } catch (e) {
      console.warn("[Bridge] poll error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

mainLoop().catch((e) => {
  console.error("[Bridge] fatal:", e);
  process.exit(1);
});