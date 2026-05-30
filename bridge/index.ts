/**
 * Lovable Bridge — runs on the user's machine.
 * Polls Lovable Cloud for jobs, forwards them to local FutuOpenD, posts results back.
 *
 * MVP: stub OpenD client so the loop end-to-end works without the real futu-api SDK installed.
 * Wire real OpenD calls in `callOpenD()` below when ready.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyUpdate } from "./self-update";

type Config = {
  cloudUrl: string;
  bridgeId: string;
  token: string;
  opendHost?: string;
  opendPort?: number;
  unlockCode?: string; // 富途交易解锁码（仅本机内存使用，不上传）
};

function loadConfig(): Config {
  const path = join(homedir(), ".lovable-trader", "config.json");
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}. 先在 /futu 页面生成配对凭证。`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

const cfg = loadConfig();
console.log(`[Bridge] starting, bridgeId=${cfg.bridgeId}, cloud=${cfg.cloudUrl}`);
const OPEND_HOST = cfg.opendHost ?? "127.0.0.1";
const OPEND_PORT = cfg.opendPort ?? 11111;
const CURRENT_VERSION = "0.1.0";

async function checkForUpdate() {
  try {
    const applied = await applyUpdate(cfg.cloudUrl, CURRENT_VERSION);
    if (applied) process.exit(0); // 守护进程会拉起新版
  } catch (e) {
    console.warn("[Bridge] update check failed:", (e as Error).message);
  }
}

// ───────── futu-api SDK (lazy, optional) ─────────
// 没装 futu-api 时退化为 stub，保证 Bridge 主循环跑通；
// 装了就走真实 OpenD。安装：npm i futu-api
type FutuModule = any;
let futuMod: FutuModule | null = null;
let quoteCtx: any = null;
let tradeCtx: any = null;
let tradeUnlocked = false;

async function ensureFutu(): Promise<FutuModule | null> {
  if (futuMod) return futuMod;
  try {
    // @ts-ignore — 运行时可选依赖
    futuMod = await import("futu-api");
    return futuMod;
  } catch {
    console.warn("[Bridge] futu-api 未安装，使用 stub 模式。安装：npm i futu-api");
    return null;
  }
}

async function getQuoteCtx() {
  if (quoteCtx) return quoteCtx;
  const mod = await ensureFutu();
  if (!mod) return null;
  const { FutuWebsocket, Common } = mod;
  quoteCtx = new FutuWebsocket();
  await quoteCtx.start({ ip: OPEND_HOST, port: OPEND_PORT, wsKey: "", connType: Common?.ConnTypeEnum?.QUOTE ?? 1 });
  return quoteCtx;
}

async function getTradeCtx() {
  if (tradeCtx) return tradeCtx;
  const mod = await ensureFutu();
  if (!mod) return null;
  const { FutuWebsocket, Common } = mod;
  tradeCtx = new FutuWebsocket();
  await tradeCtx.start({ ip: OPEND_HOST, port: OPEND_PORT, wsKey: "", connType: Common?.ConnTypeEnum?.TRADE ?? 2 });
  return tradeCtx;
}

async function unlockTradeIfNeeded() {
  if (tradeUnlocked) return;
  if (!cfg.unlockCode) return; // 模拟单不强制；真实单需要
  const ctx = await getTradeCtx();
  if (!ctx) return;
  await ctx.UnlockTrade?.({ unlock: true, pwdMD5: cfg.unlockCode });
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

/**
 * Call into FutuOpenD. Reference: https://openapi.futunn.com/futu-api-doc/
 * 没装 futu-api 时返回 stub（带 _stub: true 标记），保证主循环可测。
 */
const MARKET_ENUM: Record<string, number> = { HK: 1, US: 11, SH: 21, SZ: 22 };
// futu-api 订阅 SubType: 1=BASIC(L1), 6=ORDER_BOOK, 7=TICKER, 8=RT(逐笔), 9=BROKER（L2 套餐内）
const L1_SUBS = [1];
const L2_SUBS = [1, 6, 7, 9];

function trdEnvCode(v: unknown) { return v === "REAL" ? 1 : 0; }
function marketCode(code: string) { return MARKET_ENUM[code.split(".")[0].toUpperCase()] ?? 11; }
function symOf(code: string) { return code.split(".")[1]; }

async function callOpenD(kind: string, payload: Record<string, unknown>): Promise<unknown> {
  const mod = await ensureFutu();

  switch (kind) {
    case "quote": {
      const code = String(payload.code);
      if (!mod) return { code, last: 0, bid: 0, ask: 0, level: payload.level ?? "L1", ts: new Date().toISOString(), _stub: true };
      const ctx = await getQuoteCtx();
      const security = { market: marketCode(code), code: symOf(code) };
      const subs = payload.level === "L2" ? L2_SUBS : L1_SUBS;
      await ctx.Qot_Sub?.({ securityList: [security], subTypeList: subs, isSubOrUnSub: true, isRegOrUnRegPush: false });
      const res = await ctx.Qot_GetBasicQot?.({ securityList: [security] });
      const q = res?.s2c?.basicQotList?.[0];
      let orderBook: unknown = null;
      if (payload.level === "L2") {
        const ob = await ctx.Qot_GetOrderBook?.({ security, num: 10 });
        orderBook = { bid: ob?.s2c?.orderBookBidList ?? [], ask: ob?.s2c?.orderBookAskList ?? [] };
      }
      return {
        code, level: payload.level ?? "L1",
        last: q?.curPrice ?? 0, bid: q?.bidPrice ?? null, ask: q?.askPrice ?? null,
        orderBook, ts: new Date().toISOString(),
      };
    }

    case "list_accounts": {
      const trdEnv = trdEnvCode(payload.trdEnv);
      if (!mod) {
        return [{ accId: trdEnv === 1 ? "REAL-DEMO" : "SIM-DEMO", trdEnv: payload.trdEnv, market: "US", cash: 100000, _stub: true }];
      }
      const ctx = await getTradeCtx();
      const res = await ctx.Trd_GetAccList?.({ userID: 0 });
      const list = (res?.s2c?.accList ?? [])
        .filter((a: any) => a.trdEnv === trdEnv)
        .map((a: any) => ({
          accId: String(a.accID), trdEnv: payload.trdEnv,
          market: Object.keys(MARKET_ENUM).find((k) => MARKET_ENUM[k] === a.trdMarketAuthList?.[0]) ?? "US",
        }));
      return list;
    }

    case "positions": {
      if (!mod) {
        return [{ code: "US.AAPL", qty: 10, canSellQty: 10, costPrice: 180, marketVal: 1900, plRatio: 0.05, _stub: true }];
      }
      await unlockTradeIfNeeded();
      const ctx = await getTradeCtx();
      const res = await ctx.Trd_GetPositionList?.({
        header: { trdEnv: trdEnvCode(payload.trdEnv), accID: Number(payload.accId), trdMarket: MARKET_ENUM[String(payload.market).toUpperCase()] ?? 11 },
      });
      return (res?.s2c?.positionList ?? []).map((p: any) => ({
        code: p.code, qty: p.qty, canSellQty: p.canSellQty,
        costPrice: p.costPrice, marketVal: p.marketVal, plRatio: p.plRatio,
      }));
    }

    case "place_order": {
      const code = String(payload.code);
      if (!mod) return { orderId: `${payload.trdEnv === "REAL" ? "REAL" : "SIM"}-${Date.now()}`, status: "submitted", raw: { _stub: true, ...payload } };
      await unlockTradeIfNeeded();
      const ctx = await getTradeCtx();
      const res = await ctx.Trd_PlaceOrder?.({
        packetID: { connID: 0, serialNo: Date.now() },
        header: { trdEnv: trdEnvCode(payload.trdEnv), accID: Number(payload.accId), trdMarket: marketCode(code) },
        trdSide: payload.side === "BUY" ? 1 : 2,
        orderType: payload.orderType === "MARKET" ? 5 : 1,
        code: symOf(code),
        qty: Number(payload.qty),
        price: payload.price ? Number(payload.price) : 0,
        secMarket: marketCode(code),
      });
      return {
        orderId: String(res?.s2c?.orderID ?? `${payload.trdEnv === "REAL" ? "REAL" : "SIM"}-${Date.now()}`),
        status: res?.retType === 0 ? "submitted" : "rejected",
        raw: res ?? null,
      };
    }

    case "cancel_order": {
      if (!mod) return { ok: true, _stub: true };
      await unlockTradeIfNeeded();
      const ctx = await getTradeCtx();
      const res = await ctx.Trd_ModifyOrder?.({
        packetID: { connID: 0, serialNo: Date.now() },
        header: { trdEnv: trdEnvCode(payload.trdEnv), accID: Number(payload.accId), trdMarket: MARKET_ENUM[String(payload.market).toUpperCase()] ?? 11 },
        orderID: payload.orderId,
        modifyOrderOp: 1, // 1 = CANCEL
      });
      return { ok: res?.retType === 0, raw: res ?? null };
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
    await post("/api/public/futu/jobs/complete", {
      bridgeId: cfg.bridgeId,
      jobId: job.id,
      error: (e as Error).message,
    });
  }
}

async function mainLoop() {
  await heartbeat();
  setInterval(heartbeat, 15_000);
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000); // 每 6 小时检查一次
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