import fs from "node:fs/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BinanceMcpClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.BINANCE_MCP_ENDPOINT || "";
    this.timeoutMs = Number(options.timeoutMs || 15000);
    this.authToken = options.authToken || process.env.BINANCE_MCP_AUTH_TOKEN || "";
    this.clientName = options.clientName || "altcoin-futures-bot";
    this.clientVersion = options.clientVersion || "0.2.0";
    this.requestId = 0;
    this.initialized = false;
    this.sessionId = "";
    this.auditFile = options.auditFile || "";
    this.cooldownUntil = 0;
  }

  async audit(event) {
    if (!this.auditFile) return;
    await fs.appendFile(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8").catch(() => {});
  }

  async request(method, params = {}) {
    if (!this.endpoint) throw new Error("BINANCE_MCP_ENDPOINT is not configured");
    if (this.cooldownUntil > Date.now()) {
      throw new Error(`Binance MCP cooldown until ${new Date(this.cooldownUntil).toISOString()}`);
    }
    const notification = method.startsWith("notifications/");
    const id = notification ? undefined : ++this.requestId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
      const body = notification
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id, method, params };
      let response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        throw new Error(`Binance MCP network error: ${error.message}. Check HTTPS_PROXY/NODE_USE_ENV_PROXY or the MCP endpoint`);
      }
      const text = await response.text();
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Binance MCP HTTP 401 Unauthorized: complete OAuth in the MCP client, or provide BINANCE_MCP_AUTH_TOKEN to this standalone process");
        }
        if (response.status === 403) throw new Error("Binance MCP HTTP 403 Forbidden: the authorized account lacks the requested permission");
        if ([418, 429].includes(response.status)) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const match = text.match(/banned until\s+(\d+)/i);
          const until = Number(match?.[1]);
          this.cooldownUntil = Number.isFinite(until) && until > Date.now()
            ? until + 60_000
            : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15 * 60_000);
        }
        throw new Error(`Binance MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      if (notification || !text.trim()) return null;
      const payload = parseMcpPayload(text, response.headers.get("content-type") || "", id);
      if (payload.error) {
        const message = String(payload.error.message || "");
        if (payload.error.code === -1003 || /too many requests|banned until/i.test(message)) {
          const match = message.match(/banned until\s+(\d+)/i);
          this.cooldownUntil = Number(match?.[1]) > Date.now()
            ? Number(match[1]) + 60_000
            : Date.now() + 15 * 60_000;
        }
        throw new Error(`Binance MCP ${payload.error.code}: ${message}`);
      }
      return payload.result;
    } finally { clearTimeout(timer); }
  }

  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion }
    });
    await this.request("notifications/initialized", {});
    this.initialized = true;
    await this.audit({ type: "MCP_INITIALIZED", provider: "binance" });
  }

  async callTool(name, arguments_ = {}) {
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: arguments_ });
    await this.audit({ type: "MCP_TOOL_CALL", tool: name, arguments: arguments_ });
    return result;
  }

  healthCheck() { return this.callTool("futures_usds.checkServerTime"); }
  exchangeInformation() { return this.callTool("futures_usds.exchangeInformation"); }
  ticker24hr(symbol) { return this.callTool("futures_usds.ticker24hrPriceChangeStatistics", symbol ? { symbol } : {}); }
  markPrice(symbol) { return this.callTool("futures_usds.markPrice", symbol ? { symbol } : {}); }
  openInterest(symbol) { return this.callTool("futures_usds.openInterest", { symbol }); }
  kline(symbol, interval = "15m", limit = 50) { return this.callTool("futures_usds.klineCandlestickData", { symbol, interval, limit }); }
  orderBook(symbol, limit = 5) { return this.callTool("futures_usds.orderBook", { symbol, limit }); }
}

function parseMcpPayload(text, contentType, requestId) {
  if (!contentType.includes("text/event-stream") && !/^\s*event:|^\s*data:/m.test(text)) {
    try { return JSON.parse(text); }
    catch { throw new Error(`Binance MCP returned non-JSON response: ${text.slice(0, 300)}`); }
  }
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data);
      if (requestId === undefined || payload.id === requestId || payload.result || payload.error) return payload;
    } catch { /* ignore SSE keep-alive or non-JSON events */ }
  }
  throw new Error(`Binance MCP returned no JSON-RPC result: ${text.slice(0, 300)}`);
}

export async function withRetry(task, attempts = 2) {
  let error;
  for (let i = 0; i < attempts; i += 1) {
    try { return await task(); }
    catch (err) {
      error = err;
      if (/too many requests|banned until|cooldown|HTTP 418|HTTP 429|-1003/i.test(String(err?.message))) break;
      if (i + 1 < attempts) await sleep(500 * (i + 1));
    }
  }
  throw error;
}
