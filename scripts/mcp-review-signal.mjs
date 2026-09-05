import fs from "node:fs/promises";
import { BinanceMcpClient } from "../src/binance-mcp-client.mjs";

const signalFile = "data/analysis-signals.json";
const config = JSON.parse(await fs.readFile("mcp-config.json", "utf8"));
const snapshot = JSON.parse(await fs.readFile(signalFile, "utf8").catch(() => "{}"));
const signal = (snapshot.signals || []).find((item) => ["LONG", "SHORT"].includes(item.side));

if (!signal) {
  console.log(JSON.stringify({ ok: true, status: "NO_SIGNAL", message: "当前没有可供 MCP 复核的本地分析信号", generatedAt: snapshot.generatedAt || null }, null, 2));
  process.exit(0);
}

const reviewPlan = {
  signalId: signal.id,
  symbol: signal.symbol,
  side: signal.side,
  tools: [
    { name: "futures_usds.markPrice", arguments: { symbol: signal.symbol } },
    { name: "futures_usds.orderBook", arguments: { symbol: signal.symbol, limit: 5 } },
    { name: "futures_usds.openInterest", arguments: { symbol: signal.symbol } }
  ],
  liveOrderAllowed: false
};

const client = new BinanceMcpClient({ endpoint: process.env.BINANCE_MCP_ENDPOINT || config.endpoint, authToken: process.env.BINANCE_MCP_AUTH_TOKEN, timeoutMs: config.timeoutMs, auditFile: config.auditFile });
try {
  const markPrice = await client.markPrice(signal.symbol);
  const orderBook = await client.orderBook(signal.symbol, 5);
  const openInterest = await client.openInterest(signal.symbol);
  console.log(JSON.stringify({ ok: true, status: "REVIEWED", reviewPlan, market: { markPrice, orderBook, openInterest } }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: "MCP_AUTH_OR_TRANSPORT_REQUIRED", reviewPlan, error: String(error.message) }, null, 2));
  process.exitCode = 1;
}
