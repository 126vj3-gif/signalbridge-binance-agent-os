import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BinanceMcpClient } from "../src/binance-mcp-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const FIXTURE = path.join(ROOT, "submission", "fixtures", "demo-signal.json");
const OUTPUT = path.join(DATA_DIR, "submission-demo.ndjson");

const readJson = async (file, fallback = {}) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
};
const now = () => new Date().toISOString();
const writeAudit = async (event) => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(OUTPUT, `${JSON.stringify({ at: now(), ...event })}\n`, "utf8");
};

const config = await readJson(path.join(ROOT, "config.json"), {});
const mcpConfig = await readJson(path.join(ROOT, "mcp-config.json"), {});
const signal = await readJson(FIXTURE, {});

if (!signal.id || !signal.symbol || !["LONG", "SHORT"].includes(signal.side)) {
  throw new Error("demo fixture is invalid");
}

console.log("Binance Agent OS submission demo");
console.log("1) strategy signal -> 2) MCP market review -> 3) local risk gate -> 4) paper trade preview");
await writeAudit({ type: "DEMO_STARTED", mode: config.mode || "paper", liveOrderAllowed: false });

const endpoint = process.env.BINANCE_MCP_ENDPOINT || mcpConfig.endpoint;
if (!endpoint) {
  console.log(JSON.stringify({ status: "MCP_ENDPOINT_MISSING", next: "Set BINANCE_MCP_ENDPOINT and finish Binance OAuth in the MCP client" }, null, 2));
  await writeAudit({ type: "MCP_SKIPPED", reason: "endpoint_missing" });
} else {
  const client = new BinanceMcpClient({ endpoint, authToken: process.env[mcpConfig.authTokenEnv || "BINANCE_MCP_AUTH_TOKEN"], timeoutMs: mcpConfig.timeoutMs, auditFile: mcpConfig.auditFile });
  try {
    const health = await client.healthCheck();
    const market = await client.markPrice(signal.symbol);
    await writeAudit({ type: "MCP_REVIEW", status: "OK", symbol: signal.symbol, tools: ["futures_usds.checkServerTime", "futures_usds.markPrice"] });
    console.log(JSON.stringify({ status: "MCP_CONNECTED", health, market }, null, 2));
  } catch (error) {
    await writeAudit({ type: "MCP_REVIEW", status: "AUTH_OR_TRANSPORT_REQUIRED", error: String(error.message) });
    console.log(JSON.stringify({ status: "MCP_AUTH_OR_TRANSPORT_REQUIRED", error: String(error.message), next: "Run this demo inside an authorized Binance MCP client" }, null, 2));
  }
}

const entry = Number(signal.entry);
const stop = Number(signal.stop);
const target = Number(signal.target);
const validLevels = signal.side === "LONG"
  ? stop < entry && target > entry
  : stop > entry && target < entry;
const stopPct = Math.abs(stop - entry) / entry * 100;
const maxStopPct = Number(config.risk?.maxSignalStopPct ?? 3);
const riskGate = validLevels && stopPct <= maxStopPct && config.mode === "paper";
const preview = {
  status: riskGate ? "PAPER_TRADE_PREVIEW" : "REJECTED",
  symbol: signal.symbol,
  side: signal.side,
  entry,
  stop,
  target,
  stopPct: Number(stopPct.toFixed(4)),
  maxStopPct,
  marginUsdt: Number(config.risk?.marginPerTradeUsdt ?? 20),
  leverage: Number(config.risk?.leverage ?? 3),
  liveOrderAllowed: false,
  reason: riskGate ? "risk checks passed; no live order is sent" : "paper mode or invalid risk levels"
};
await writeAudit({ type: "TRADE_PREVIEW", ...preview });
console.log(JSON.stringify(preview, null, 2));
console.log(`Audit: ${OUTPUT}`);
