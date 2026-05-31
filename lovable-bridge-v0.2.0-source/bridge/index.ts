/**
 * Lovable Bridge v0.2.1 — runs on the user's machine.
 * Polls Lovable Cloud for jobs, forwards them to local FutuOpenD, posts results back.
 *
 * 真实接入 futu-api（v10.x）。OpenD 默认端口 11111，无需区分 quote/trade，单一连接。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyUpdate } from "./self-update";
// 静态 import：bun --compile 会把它打进二进制
// @ts-ignore — futu-api 没有 d.ts
import ftWebsocket from "futu-api";

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

function loadConfig(): Config {
  const path = join(homedir(), ".lovable-trader", "config.json");
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}. 先在 /futu 页面生成配对凭证。`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

const cfg = loadConfig();
console.log(`[Bridge] starting v0.2.1, bridgeId=${cfg.bridgeId}, cloud=${cfg.cloudUrl}`);
const OPEND_HOST = cfg.opendHost ?? "127.0.0.1";
const OPEND_PORT = cfg.opendPort ?? 11111;
const OPEND_SSL = cfg.opendSsl ?? false;
const OPEND_KEY = cfg.opendKey ?? "";
const CURRENT_VERSION = "0.2.1";

async function checkForUpdate() {
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

function connect(): Promise<void> {
  if (loginPromise) return loginPromise;
  loginPromise = new Promise<void>((resolve, reject) => {
    try {
      ws = new ftWebsocket();
      const timer = setTimeout(() => reject(new Error("OpenD login timeout (10s) — 检查 FutuOpenD 是否启动并已登录富途账号")), 10_000);
      ws.onlogin = (ret: number, msg: string) => {
        clearTimeout(timer);
        if (ret === 0) {
          console.log(`[Bridge] OpenD connected at ${OPEND_HOST}:${OPEND_PORT}`);
          resolve();
        } else {
          reject(new Error(`OpenD login failed: ret=${ret} ${msg}`));
        }
      };
      ws.start(OPEND_HOST, OPEND_PORT, OPEND_SSL, OPEND_KEY);
    } catch (e) {
      reject(e as Error);
    }
  }).catch((e) => {
    // 让下次重试
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
// Qot_Common.SubType: 1=BASIC 6=ORDER_BOOK 7=TICKER 9=BROKER
const L1_SUBS = [1];
const L2_SUBS = [1, 6, 7, 9];

function trdEnvCode(v: unknown) { return v === "REAL" ? 1 : 0; } // 0=SIMULATE 1=REAL
function marketCode(code: string) { return MARKET_ENUM[code.split(".")[0].toUpperCase()] ?? 11; }
function symOf(code: string) { return code.split(".")[1]; }

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