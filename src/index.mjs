import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(ROOT, "config.json");
const STATE_FILE = path.join(DATA_DIR, "paper-state.json");
const SIGNAL_FILE = path.join(DATA_DIR, "latest-signals.json");
const ANALYSIS_SIGNAL_FILE = path.join(DATA_DIR, "analysis-signals.json");
const INBOX_FILE = path.join(DATA_DIR, "signal-inbox.ndjson");
const RESULT_FILE = path.join(DATA_DIR, "execution-results.ndjson");
const ANALYSIS_ONLY = process.argv.includes("--analyze-only");
const LOCK_FILE = path.join(DATA_DIR, ANALYSIS_ONLY ? "analysis-bot.lock" : "paper-bot.lock");
const API_LOCK_FILE = path.join(DATA_DIR, "binance-api.lock");
const API_COOLDOWN_FILE = path.join(DATA_DIR, "binance-api-cooldown.json");
const API_RATE_FILE = path.join(DATA_DIR, "binance-api-rate.json");
const API = "https://fapi.binance.com";
// Keep the full-market scan, but spread public REST calls out so concurrent
// workers cannot burst the shared Binance IP quota.
const API_MIN_INTERVAL_MS = 200;
const API_JITTER_MS = 40;
const API_TIMEOUT_MS = 8000;
let nextApiAt = 0;
let apiSchedule = Promise.resolve();

async function acquireApiSlot() {
  for (;;) {
    const cooldown = await readJson(API_COOLDOWN_FILE, { until: 0 });
    if (Number(cooldown.until) > Date.now()) {
      throw new Error(`Binance API cooldown until ${new Date(cooldown.until).toISOString()}`);
    }
    try {
      const handle = await fs.open(API_LOCK_FILE, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
      await handle.close();
      const sharedRate = await readJson(API_RATE_FILE, { nextAt: 0 });
      const wait = Math.max(0, nextApiAt - Date.now(), Number(sharedRate.nextAt || 0) - Date.now());
      if (wait) await sleep(wait);
      nextApiAt = Date.now() + API_MIN_INTERVAL_MS + Math.floor(Math.random() * API_JITTER_MS);
      await writeJson(API_RATE_FILE, { nextAt: nextApiAt, updatedAt: now(), pid: process.pid });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await fs.readFile(API_LOCK_FILE, "utf8"));
        if (Date.now() - Number(lock.at) > 30000) await fs.unlink(API_LOCK_FILE).catch(() => {});
      } catch { await fs.unlink(API_LOCK_FILE).catch(() => {}); }
      await sleep(100);
    }
  }
}

async function releaseApiSlot() {
  await fs.unlink(API_LOCK_FILE).catch(() => {});
}

async function setApiCooldown(ms) {
  await writeJson(API_COOLDOWN_FILE, { until: Date.now() + ms, setAt: now(), pid: process.pid });
}

async function setApiCooldownUntil(until) {
  const current = await readJson(API_COOLDOWN_FILE, { until: 0 });
  const nextUntil = Math.max(Number(current.until) || 0, Number(until) || 0);
  await writeJson(API_COOLDOWN_FILE, { until: nextUntil, setAt: now(), pid: process.pid });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function appendExecutionResult(result) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(RESULT_FILE, `${JSON.stringify({ ...result, reportedAt: now() })}\n`, "utf8");
}

async function postAnalysisSignal(signal, config) {
  const host = config.bridge?.host || "127.0.0.1";
  const port = config.bridge?.port || 18787;
  const response = await fetch(`http://${host}:${port}/signal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signal),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`bridge rejected signal: ${response.status}`);
  return response.json();
}

async function acquireLock() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const handle = await fs.open(LOCK_FILE, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }), "utf8");
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const existing = JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
      try { process.kill(Number(existing.pid), 0); }
      catch { stale = true; }
    } catch { stale = true; }
    if (!stale) throw new Error(`paper bot already running (lock: ${LOCK_FILE})`);
    await fs.unlink(LOCK_FILE).catch(() => {});
    const handle = await fs.open(LOCK_FILE, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }), "utf8");
    await handle.close();
    return true;
  }
}

async function releaseLock() {
  await fs.unlink(LOCK_FILE).catch(() => {});
}

async function api(pathname) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
      await acquireApiSlot();
      let response;
      try {
        response = await fetch(`${API}${pathname}`, {
          headers: { accept: "application/json", "user-agent": "altcoin-futures-bot/0.2" },
          signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
      } catch (error) {
        await releaseApiSlot();
        if (attempt === 2) throw new Error(`Binance request failed after retries: ${pathname} (${error.message})`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      await releaseApiSlot();
      if (response.ok) return response.json();
      const retryable = [418, 429, 500, 502, 503, 504].includes(response.status);
      const errorBody = await response.text().catch(() => "");
      const bannedUntil = Number(errorBody.match(/banned until\s+(\d+)/i)?.[1]);
      lastError = new Error(`Binance API ${response.status}: ${pathname}${bannedUntil ? ` (banned until ${new Date(bannedUntil).toISOString()})` : ""}`);
      if (!retryable || attempt === 2) throw lastError;
      if ([418, 429].includes(response.status)) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(bannedUntil) && bannedUntil > Date.now()) await setApiCooldownUntil(bannedUntil + 60 * 1000);
        else await setApiCooldown(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60 * 60 * 1000);
        throw lastError;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1);
      await sleep(Math.min(backoffMs, 3000));
  }
  throw lastError;
}

function isApiThrottleError(error) {
  return /Binance API (418|429)/i.test(String(error?.message)) ||
    /banned until|API cooldown/i.test(String(error?.message));
}

function pickUniverse(exchangeInfo, tickers, config) {
  const listed = new Map(exchangeInfo.symbols.map((s) => [s.symbol, s]));
  const cutoff = Date.now() - config.universe.minListingAgeDays * 86400000;
  return tickers
    .filter((t) => {
      const s = listed.get(t.symbol);
      return s && s.status === "TRADING" && s.contractType === "PERPETUAL" &&
        /^[A-Z0-9]+USDT$/.test(t.symbol) &&
        s.quoteAsset === config.universe.quoteAsset &&
        !config.universe.exclude.includes(t.symbol) &&
        Number(t.quoteVolume) >= config.universe.minQuoteVolume24h &&
        Number(s.onboardDate || 0) < cutoff;
    })
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, config.universe.maxSymbolsPerScan > 0 ? config.universe.maxSymbolsPerScan : undefined);
}

function ema(values, period) {
  if (values.length < period) return NaN;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const item of values.slice(period)) value = alpha * item + (1 - alpha) * value;
  return value;
}

function trendState(klines) {
  const closes = (klines || []).map((k) => Number(k[4]));
  const fast = ema(closes, 9), slow = ema(closes, 21);
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return "NEUTRAL";
  return fast > slow ? "UP" : fast < slow ? "DOWN" : "NEUTRAL";
}

function atrPct(klines, period = 14) {
  if (!klines || klines.length < period + 1) return NaN;
  const trs = [];
  for (let i = 1; i < klines.length; i += 1) {
    const high = Number(klines[i][2]);
    const low = Number(klines[i][3]);
    const previousClose = Number(klines[i - 1][4]);
    trs.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  const close = Number(klines.at(-1)[4]);
  return close > 0 ? trs.slice(-period).reduce((a, b) => a + b, 0) / period / close * 100 : NaN;
}

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function analyze(symbol, ticker, klines, market, config) {
  if (!klines || klines.length < 25) return null;
  const closes = klines.map((k) => Number(k[4]));
  const volumes = klines.map((k) => Number(k[5]));
  const last = closes.at(-1);
  const prior = closes.at(-5);
  const move15m = ((last / prior) - 1) * 100;
  const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volumeRatio = volumes.at(-1) / Math.max(avgVolume, 1e-9);
  const move24h = Number.isFinite(Number(ticker.priceChangePercent)) && Number(ticker.priceChangePercent) !== 0
    ? Number(ticker.priceChangePercent)
    : (() => {
      const higher = market?.higherKlines || [];
      const base = higher.length >= 25 ? Number(higher.at(-25)[4]) : NaN;
      return Number.isFinite(base) && base > 0 ? (last / base - 1) * 100 : NaN;
    })();
  const bid = Number(ticker.bidPrice);
  const ask = Number(ticker.askPrice);
  const spreadPct = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : Infinity;
  const fundingRate = Number(market?.fundingRate);
  const openInterestUsd = Number(market?.openInterestUsd);
  const trend15m = trendState(klines);
  const trend1h = trendState(market?.higherKlines);
  const volatilityPct = atrPct(klines, config.strategy.atrPeriod);
  const regime = market?.regime || "NEUTRAL";
  if (!Number.isFinite(spreadPct) || spreadPct > config.strategy.maxSpreadPct) return null;
  if (!Number.isFinite(fundingRate) || Math.abs(fundingRate) > config.strategy.maxAbsFundingRate) return null;
  if (!Number.isFinite(openInterestUsd) || openInterestUsd < config.strategy.minOpenInterestUsd) return null;
  if (!Number.isFinite(volatilityPct) || volatilityPct < config.strategy.minAtrPct || volatilityPct > config.strategy.maxAtrPct) return null;
  const longScore = (move24h >= config.strategy.minMove24hPct ? 1 : 0) +
    (move15m > 0 ? 1 : 0) + (volumeRatio >= config.strategy.minVolumeRatio ? 1 : 0) +
    (trend15m === "UP" ? 1 : 0) + (trend1h === "UP" ? 1 : 0) + (regime !== "BEAR" ? 1 : 0);
  const shortScore = (move24h <= -config.strategy.minMove24hPct ? 1 : 0) +
    (move15m < 0 ? 1 : 0) + (volumeRatio >= config.strategy.minVolumeRatio ? 1 : 0) +
    (trend15m === "DOWN" ? 1 : 0) + (trend1h === "DOWN" ? 1 : 0) + (regime !== "BULL" ? 1 : 0);
  const side = longScore >= shortScore && longScore >= config.strategy.minScore ? "LONG" :
    shortScore > longScore && shortScore >= config.strategy.minScore ? "SHORT" : "WATCH";
  const stopPct = clamp(volatilityPct * config.strategy.atrStopMultiplier,
    config.strategy.minStopPct, config.strategy.maxStopPct);
  const direction = side === "LONG" ? 1 : -1;
  return {
    symbol, side, score: Math.max(longScore, shortScore), price: last,
    move24hPct: move24h, move15mPct: move15m, volumeRatio: Number(volumeRatio.toFixed(2)),
    spreadPct: Number(spreadPct.toFixed(4)), fundingRate, openInterestUsd,
    trend15m, trend1h, regime, volatilityPct: Number(volatilityPct.toFixed(3)),
    entry: last,
    stop: side === "WATCH" ? null : last * (1 - direction * stopPct / 100),
    target: side === "WATCH" ? null : last * (1 + direction * stopPct * config.strategy.rewardRisk / 100),
    generatedAt: now(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    reason: side === "WATCH" ? "趋势或成交量未同时满足" : "24小时方向、15分钟动量和成交量条件满足"
  };
}

function riskCheck(signal, state, config) {
  if (signal.side === "WATCH") return { ok: false, reason: "WATCH" };
  if (state.positions.length >= config.risk.maxOpenPositions) return { ok: false, reason: "MAX_OPEN_POSITIONS" };
  if (Date.parse(signal.expiresAt) <= Date.now()) return { ok: false, reason: "SIGNAL_EXPIRED" };
  const plannedEntry = Number(signal.entry || signal.price);
  const plannedStop = Number(signal.stop);
  if (Number.isFinite(plannedEntry) && plannedEntry > 0 && Number.isFinite(plannedStop) && plannedStop > 0) {
    const stopPct = Math.abs(plannedStop - plannedEntry) / plannedEntry * 100;
    if (Number.isFinite(config.risk.maxSignalStopPct) && stopPct > config.risk.maxSignalStopPct) {
      return { ok: false, reason: "STOP_TOO_WIDE" };
    }
  }
  if (state.positions.some((p) => p.symbol === signal.symbol)) return { ok: false, reason: "DUPLICATE_POSITION" };
  const cooldownMs = config.risk.cooldownMinutes * 60 * 1000;
  const recentlyClosed = [...state.events].reverse().find((event) =>
    event.position?.symbol === signal.symbol && /PAPER_(STOP|TARGET)/.test(event.type) &&
    Date.now() - Date.parse(event.at) < cooldownMs);
  if (recentlyClosed) return { ok: false, reason: "COOLDOWN" };
  const day = new Date().toISOString().slice(0, 10);
  if (state.daily.date !== day) { state.daily = { date: day, realizedPnl: 0 }; }
  const maxLoss = config.risk.paperEquityUsdt * config.risk.maxDailyLossPct / 100;
  if (state.daily.realizedPnl <= -maxLoss) return { ok: false, reason: "DAILY_LOSS_LIMIT" };
  return { ok: true };
}

function simulateOpen(signal, state, config) {
  const direction = signal.side === "LONG" ? 1 : -1;
  const notionalAtConfiguredMargin = config.risk.marginPerTradeUsdt * config.risk.leverage;
  const estimatedFees = notionalAtConfiguredMargin * config.risk.takerFeePct / 100 * 2;
  const stopLossAtConfiguredMargin = notionalAtConfiguredMargin * config.risk.stopLossPct / 100 + estimatedFees;
  const maxLoss = config.risk.paperEquityUsdt * config.risk.maxRiskPctPerTrade / 100;
  const marginUsdt = Math.min(config.risk.marginPerTradeUsdt,
    maxLoss > 0 && stopLossAtConfiguredMargin > maxLoss
      ? maxLoss / (config.risk.leverage * config.risk.stopLossPct / 100 + 2 * config.risk.leverage * config.risk.takerFeePct / 100)
      : config.risk.marginPerTradeUsdt);
  const baseExecutionPrice = Number(signal.executionPrice || signal.price);
  const entry = baseExecutionPrice * (1 + direction * config.risk.slippagePct / 100);
  const preserveSignalLevels = signal.executionMode === "external";
  const stop = preserveSignalLevels ? Number(signal.stop) : entry * (1 - direction * config.risk.stopLossPct / 100);
  const target = preserveSignalLevels ? Number(signal.target) : entry * (1 + direction * config.risk.takeProfitPct / 100);
  const position = {
    id: `${signal.id || signal.symbol}-${Date.now()}`, signalId: signal.id || null,
    symbol: signal.symbol, side: signal.side, entry, stop, target,
    plannedEntry: signal.entry ? Number(signal.entry) : null,
    marginUsdt: Number(marginUsdt.toFixed(6)),
    leverage: config.risk.leverage, openedAt: now(), status: "PAPER_OPEN"
  };
  state.positions.push(position);
  state.events.push({ type: "PAPER_OPEN", at: now(), position });
  return position;
}

async function updatePositions(state, tickerMap, config) {
  const remaining = [];
  for (const position of state.positions) {
    const ticker = tickerMap.get(position.symbol);
    const current = ticker ? Number(ticker.markPrice || ticker.lastPrice) : NaN;
    if (!Number.isFinite(current)) { remaining.push(position); continue; }
    const direction = position.side === "LONG" ? 1 : -1;
    const hitStop = direction === 1 ? current <= position.stop : current >= position.stop;
    const hitTarget = direction === 1 ? current >= position.target : current <= position.target;
    if (!hitStop && !hitTarget) { remaining.push(position); continue; }
    const rawExit = direction === 1 ? Number(ticker.bidPrice || current) : Number(ticker.askPrice || current);
    const exit = rawExit * (1 - direction * config.risk.slippagePct / 100);
    const pnlPct = direction * ((exit - position.entry) / position.entry) * 100;
    const notional = position.marginUsdt * position.leverage;
    const fees = notional * config.risk.takerFeePct / 100 * 2;
    const pnlUsdt = notional * (pnlPct / 100) - fees;
    const closed = { ...position, exit, pnlPct, feesUsdt: fees, pnlUsdt, status: hitStop ? "PAPER_STOP" : "PAPER_TARGET", closedAt: now() };
    state.events.push({ type: closed.status, at: now(), position: closed });
    state.daily.realizedPnl += pnlUsdt;
    await appendExecutionResult({
      type: "POSITION_CLOSED", status: closed.status, signalId: position.signalId || null,
      symbol: position.symbol, side: position.side, position: closed,
      pnlUsdt: Number(pnlUsdt.toFixed(6))
    });
  }
  state.positions = remaining;
  state.daily.realizedPnl = Number(state.daily.realizedPnl.toFixed(6));
}

async function consumeExternalSignals(state, tickerMap, config) {
  const raw = await fs.readFile(INBOX_FILE, "utf8").catch(() => "");
  if (!raw.trim()) return 0;
  const processed = new Set(state.processedSignalIds || []);
  let accepted = 0;
  for (const line of raw.split("\n").filter(Boolean)) {
    let signal;
    try { signal = JSON.parse(line); } catch { continue; }
    if (!signal.id || processed.has(signal.id)) continue;
    processed.add(signal.id);
    const symbol = String(signal.symbol || "").toUpperCase();
    const ticker = tickerMap.get(symbol);
    const current = Number(ticker?.markPrice || ticker?.lastPrice);
    const direction = signal.side === "LONG" ? 1 : signal.side === "SHORT" ? -1 : 0;
    const entry = Number(signal.entry), stop = Number(signal.stop), target = Number(signal.target);
    const levelsOk = direction !== 0 && entry > 0 && stop > 0 && target > 0 &&
      (direction === 1 ? stop < entry && target > entry : stop > entry && target < entry);
    const deviation = Number.isFinite(current) && entry > 0 ? Math.abs(current - entry) / entry * 100 : Infinity;
    let reason = null;
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) reason = "INVALID_SYMBOL";
    else if (config.strictSignalSource && signal.source !== "local-upgraded-strategy") reason = "UNTRUSTED_SOURCE";
    else if (!Number.isFinite(Date.parse(signal.expiresAt)) || Date.parse(signal.expiresAt) <= Date.now()) reason = "SIGNAL_EXPIRED";
    else if (!levelsOk) reason = "INVALID_LEVELS";
    else if (!Number.isFinite(current)) reason = "MARKET_DATA_MISSING";
    else if (deviation > config.risk.maxSignalPriceDeviationPct) reason = "PRICE_DEVIATION";
    else {
      const executionPrice = signal.side === "LONG"
        ? Number(ticker?.askPrice || current)
        : Number(ticker?.bidPrice || current);
      const normalized = { ...signal, symbol, side: signal.side, price: current, executionPrice, stop, target };
      const check = riskCheck(normalized, state, config);
      if (!check.ok) reason = check.reason;
      else {
        normalized.executionMode = "external";
        const position = simulateOpen(normalized, state, config);
        state.events.push({ type: "EXTERNAL_SIGNAL_ACCEPTED", at: now(), symbol, id: signal.id, source: signal.source || "analysis-agent" });
        await appendExecutionResult({
          type: "SIGNAL_EXECUTED", status: "PAPER_OPEN", signalId: signal.id,
          source: signal.source || "analysis-agent", symbol, side: signal.side,
          position
        });
        accepted += 1;
      }
    }
    if (reason) {
      state.events.push({ type: "EXTERNAL_SIGNAL_REJECTED", at: now(), symbol, id: signal.id, reason });
      await appendExecutionResult({
        type: "SIGNAL_REJECTED", status: "REJECTED", signalId: signal.id,
        source: signal.source || "analysis-agent", symbol, side: signal.side || null, reason
      });
    }
  }
  state.processedSignalIds = [...processed].slice(-2000);
  return accepted;
}

async function scan(config, state) {
  const analysisMode = ANALYSIS_ONLY || !config.executionOnly;
  let universe = [];
  let allTickerMap;
  let premiumMap = new Map();
  if (!analysisMode) {
    const books = await api("/fapi/v1/ticker/bookTicker");
    allTickerMap = new Map(books.map((t) => {
      const bid = Number(t.bidPrice);
      const ask = Number(t.askPrice);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
      return [t.symbol, {
        symbol: t.symbol,
        lastPrice: String(mid),
        bidPrice: t.bidPrice,
        askPrice: t.askPrice,
        markPrice: String(mid)
      }];
    }));
  } else {
    try {
      // Avoid a burst at scan start; these responses are cheap to fetch and
      // are intentionally requested one after the other.
      const exchangeInfo = await api("/fapi/v1/exchangeInfo");
      const tickers = await api("/fapi/v1/ticker/24hr");
      universe = pickUniverse(exchangeInfo, tickers, config);
      allTickerMap = new Map(tickers.map((t) => [t.symbol, t]));
    } catch (error) {
      // Never fan out fallback requests after a throttle/ban response.
      if (isApiThrottleError(error)) throw error;
      state.events.push({ type: "UNIVERSE_FALLBACK", at: now(), error: String(error.message) });
      let fallbackSource;
      try { fallbackSource = await api("/fapi/v1/ticker/bookTicker"); }
      catch { fallbackSource = await api("/fapi/v1/ticker/price"); }
      const fallback = fallbackSource
        .filter((t) => /^[A-Z0-9]+USDT$/.test(t.symbol) && !config.universe.exclude.includes(t.symbol))
        .map((t) => ({
          ...t,
          priceChangePercent: NaN,
          quoteVolume: 0,
          bidPrice: t.bidPrice || t.price,
          askPrice: t.askPrice || t.price,
          lastPrice: t.lastPrice || t.price
        }))
        .slice(0, config.universe.maxSymbolsPerScan > 0 ? config.universe.maxSymbolsPerScan : undefined);
      universe = fallback;
      allTickerMap = new Map(fallback.map((t) => [t.symbol, t]));
    }
    try {
      const premiums = await api("/fapi/v1/premiumIndex");
      premiumMap = new Map(premiums.map((item) => [item.symbol, item]));
    } catch (error) {
      state.events.push({ type: "PREMIUM_DATA_ERROR", at: now(), error: String(error.message) });
    }
  }
  const tickerMap = analysisMode ? new Map(universe.map((t) => [t.symbol, t])) : allTickerMap;
  const signals = [];
  const externalAccepted = analysisMode ? 0 : await consumeExternalSignals(state, allTickerMap, config);
  if (!analysisMode) await updatePositions(state, allTickerMap, config);
  let regime = "NEUTRAL";
  let regimeKlines = [];
  if (analysisMode) {
    try {
      regimeKlines = await api("/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=60");
      const btcTrend = trendState(regimeKlines);
      regime = btcTrend === "UP" ? "BULL" : btcTrend === "DOWN" ? "BEAR" : "NEUTRAL";
    } catch (error) {
      state.events.push({ type: "REGIME_DATA_ERROR", at: now(), error: String(error.message) });
    }
  }
  const analysisUniverse = universe.slice(0, config.strategy.deepAnalysisSymbols > 0 ? config.strategy.deepAnalysisSymbols : undefined);
  // Four symbols per batch, with each symbol's requests serialized. This
  // caps in-flight REST calls and preserves a complete scan without bursts.
  for (let i = 0; analysisMode && i < analysisUniverse.length; i += 4) {
    const batch = analysisUniverse.slice(i, i + 4);
    const analyzed = await Promise.all(batch.map(async (t) => {
      try {
        const klines = await api(`/fapi/v1/klines?symbol=${encodeURIComponent(t.symbol)}&interval=15m&limit=30`);
        const higherKlines = await api(`/fapi/v1/klines?symbol=${encodeURIComponent(t.symbol)}&interval=1h&limit=60`);
        const oi = await api(`/fapi/v1/openInterest?symbol=${encodeURIComponent(t.symbol)}`);
        const premium = premiumMap.get(t.symbol) || {};
        return analyze(t.symbol, t, klines, {
          fundingRate: premium.lastFundingRate,
          openInterestUsd: Number(oi.openInterest) * Number(t.lastPrice),
          higherKlines,
          regime
        }, config);
      } catch (error) {
        if (isApiThrottleError(error)) throw error;
        state.events.push({ type: "DATA_ERROR", at: now(), symbol: t.symbol, error: String(error.message) });
        return null;
      }
    }));
    signals.push(...analyzed.filter(Boolean));
  }
  signals.sort((a, b) => b.score - a.score || Math.abs(b.move24hPct) - Math.abs(a.move24hPct));
  const selected = signals.slice(0, 3);
  const selectedWithIds = selected.map((signal) => ({
    ...signal,
    id: signal.id || `local-${signal.symbol}-${Date.now()}`,
    source: "local-upgraded-strategy"
  }));
  const signalFile = ANALYSIS_ONLY ? ANALYSIS_SIGNAL_FILE : SIGNAL_FILE;
  if (ANALYSIS_ONLY && universe.length === 0) {
    state.events.push({ type: "INCOMPLETE_MARKET_DATA", at: now(), error: "No eligible universe available; preserving prior analysis signals" });
    return { scanned: 0, signals: [], externalAccepted };
  }
  await writeJson(signalFile, { generatedAt: now(), signals: selectedWithIds, scanned: analysisMode ? tickerMap.size : allTickerMap.size, deepAnalyzed: analysisMode ? analysisUniverse.length : 0 });
  if (ANALYSIS_ONLY) {
    for (const signal of selectedWithIds.filter((item) => item.side === "LONG" || item.side === "SHORT")) {
      try { await postAnalysisSignal(signal, config); }
      catch (error) { state.events.push({ type: "BRIDGE_SEND_ERROR", at: now(), symbol: signal.symbol, error: String(error.message) }); }
    }
  } else if (!config.executionOnly) {
    for (const signal of selectedWithIds) {
      const check = riskCheck(signal, state, config);
      if (check.ok && config.mode === "paper") simulateOpen(signal, state, config);
      else state.events.push({ type: "SIGNAL_REJECTED", at: now(), symbol: signal.symbol, reason: check.reason });
    }
  }
  state.lastScanAt = now();
  if (!ANALYSIS_ONLY) await writeJson(STATE_FILE, state);
  return { scanned: analysisMode ? universe.length : allTickerMap.size, signals: selectedWithIds, externalAccepted };
}

async function main() {
  await acquireLock();
  const config = await readJson(CONFIG_FILE, await readJson(path.join(ROOT, "config.example.json"), {}));
  const stateFile = ANALYSIS_ONLY ? path.join(DATA_DIR, "analysis-state.json") : STATE_FILE;
  const state = await readJson(stateFile, { positions: [], events: [], daily: { date: "", realizedPnl: 0 } });
  if (config.mode !== "paper") throw new Error("仅允许 paper 模式；实盘执行器尚未实现");
  try {
    if (ANALYSIS_ONLY && config.strategy.strictFullMarketScan &&
        (config.universe.maxSymbolsPerScan !== 0 || config.strategy.deepAnalysisSymbols !== 0)) {
      throw new Error("strictFullMarketScan requires maxSymbolsPerScan=0 and deepAnalysisSymbols=0");
    }
    const once = process.argv.includes("--once");
  do {
    try {
      const result = await scan(config, state);
      console.log(JSON.stringify({ at: now(), mode: config.mode, ...result }, null, 2));
    } catch (error) {
        state.events.push({ type: "SCAN_ERROR", at: now(), error: String(error.message) });
        await writeJson(stateFile, state);
      console.error(`[${now()}] ${error.message}`);
    }
    if (!once) await sleep(config.intervalMs);
    } while (!once);
  } finally {
    await releaseLock();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
