import { BinanceMcpClient } from "../src/binance-mcp-client.mjs";
import fs from "node:fs/promises";

let fileConfig = {};
try { fileConfig = JSON.parse(await fs.readFile("mcp-config.json", "utf8")); } catch {}
const client = new BinanceMcpClient({
  endpoint: process.env.BINANCE_MCP_ENDPOINT || fileConfig.endpoint,
  authToken: process.env.BINANCE_MCP_AUTH_TOKEN,
  timeoutMs: fileConfig.timeoutMs,
  auditFile: fileConfig.auditFile || "data/mcp-audit.ndjson"
});
try {
  console.log(JSON.stringify({ ok: true, provider: "binance-mcp", authConfigured: Boolean(process.env.BINANCE_MCP_AUTH_TOKEN), result: await client.healthCheck() }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, provider: "binance-mcp", authConfigured: Boolean(process.env.BINANCE_MCP_AUTH_TOKEN), error: String(error.message), next: "Complete OAuth in the MCP client, or set BINANCE_MCP_AUTH_TOKEN for this standalone process" }, null, 2));
  process.exitCode = 1;
}
