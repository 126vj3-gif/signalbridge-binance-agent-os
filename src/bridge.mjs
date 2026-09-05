import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(ROOT, "config.json");
const INBOX_FILE = path.join(DATA_DIR, "signal-inbox.ndjson");
const RESULT_FILE = path.join(DATA_DIR, "execution-results.ndjson");
const STATE_FILE = path.join(DATA_DIR, "paper-state.json");

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

function validate(signal) {
  for (const key of ["id", "symbol", "side", "entry", "stop", "target", "expiresAt"]) {
    if (signal?.[key] === undefined) return "missing_required_field";
  }
  if (!/^[A-Z0-9]+USDT$/.test(String(signal.symbol))) return "invalid_symbol";
  if (!["LONG", "SHORT"].includes(signal.side)) return "invalid_side";
  for (const key of ["entry", "stop", "target"]) if (!Number.isFinite(Number(signal[key])) || Number(signal[key]) <= 0) return `invalid_${key}`;
  const expiry = Date.parse(signal.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return "expired";
  if (expiry - Date.now() > 15 * 60 * 1000) return "expiry_too_long";
  const long = signal.side === "LONG";
  if (long ? !(signal.stop < signal.entry && signal.target > signal.entry) : !(signal.stop > signal.entry && signal.target < signal.entry)) return "invalid_levels";
  return null;
}

function normalize(signal) {
  return {
    ...signal,
    id: String(signal.id),
    symbol: String(signal.symbol).toUpperCase(),
    side: String(signal.side).toUpperCase(),
    entry: Number(signal.entry),
    stop: Number(signal.stop),
    target: Number(signal.target),
    source: signal.source || "analysis-agent"
  };
}

async function readBody(request) {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 16384) throw new Error("payload_too_large");
  }
  return JSON.parse(data || "{}");
}

const config = await readJson(CONFIG_FILE, { mode: "paper", bridge: { host: "127.0.0.1", port: 8787 } });
if (config.mode !== "paper") throw new Error("bridge only permits paper mode");
await fs.mkdir(DATA_DIR, { recursive: true });

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  try {
    if (request.method === "GET" && request.url === "/health") {
      const raw = await fs.readFile(INBOX_FILE, "utf8").catch(() => "");
      const state = await readJson(STATE_FILE, { processedSignalIds: [] });
      const processed = new Set(state.processedSignalIds || []);
      const total = raw.split("\n").filter(Boolean);
      const pending = total.reduce((count, line) => {
        try { return processed.has(JSON.parse(line).id) ? count : count + 1; }
        catch { return count + 1; }
      }, 0);
      response.end(JSON.stringify({ ok: true, mode: config.mode, queued: pending, totalSignals: total.length, at: new Date().toISOString() }));
      return;
    }
    if (request.method === "POST" && request.url === "/signal") {
      const signal = normalize(await readBody(request));
      const error = validate(signal);
      if (error) { response.statusCode = 400; response.end(JSON.stringify({ ok: false, error })); return; }
      await fs.appendFile(INBOX_FILE, `${JSON.stringify({ ...signal, source: signal.source || "analysis-agent", receivedAt: new Date().toISOString() })}\n`, "utf8");
      response.end(JSON.stringify({ ok: true, accepted: true, id: signal.id }));
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/results")) {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 500);
      const lines = (await fs.readFile(RESULT_FILE, "utf8").catch(() => ""))
        .split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
      response.end(JSON.stringify({ ok: true, results: lines }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ ok: false, error: String(error.message) }));
  }
});

const host = config.bridge?.host || "127.0.0.1";
const port = config.bridge?.port || 8787;
server.listen(port, host, () => console.log(JSON.stringify({ ok: true, service: "signal-bridge", host, port, mode: config.mode })));
