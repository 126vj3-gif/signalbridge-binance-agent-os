# SignalBridge — Binance Agent OS submission

SignalBridge is a safety-first altcoin futures workflow for Binance Agent OS. It scans the USDT perpetual universe, turns a candidate into a structured signal, asks Binance MCP for a fresh market check, then applies a local risk gate before producing an execution preview.

The important design choice is separation of responsibilities:

```text
Market scan → structured signal → Binance MCP review → local risk gate → paper execution + audit
```

The local executor is deliberately locked to paper mode in this repository. It never pretends that a paper fill is a Binance order. A judge can run the same flow with an authorized Binance MCP client and inspect the audit trail.

## What is demonstrated

- Full-market USDT perpetual discovery with liquidity and listing-age filters.
- Multi-timeframe trend, momentum, volume, volatility, funding and open-interest checks.
- Binance MCP JSON-RPC client with initialization, tool calls and audit logging.
- A second market-data check before a trade preview (`markPrice`, `orderBook`, `openInterest`).
- Local controls for stale signals, price deviation, stop width, duplicate positions, cooldown, daily loss and maximum open positions.
- Deterministic paper-trade demo that can be replayed without risking funds.

## Run the demo

```powershell
npm install
npm run check
npm run demo:submission
```

On Windows with the local proxy used by this workspace, run `npm run demo:submission:win` or `npm run mcp:health:win` to set the proxy automatically.

Without an authorized MCP session the demo reports `MCP_AUTH_OR_TRANSPORT_REQUIRED` and still shows the risk-gated paper preview. A standalone Node process cannot inherit the OAuth session stored by Codex. For the submission, show the MCP market-review step inside the authorized MCP client and show this repository's paper preview separately; do not copy OAuth tokens into the repository.

## Security boundary

`config.json` is paper-only (`mode: paper`, `allowTrading: false`). No API secret is stored in this repository. Any live-trading integration would require a separate design, explicit user confirmation, restricted permissions and independent testing; it is intentionally outside this demo.
