# 90-second judge demo

1. Start with the problem: scanning many altcoins is not enough; a stale or oversized signal must be rejected before execution.
2. Run `npm run demo:submission`.
3. Show the MCP step: the client initializes Binance MCP and requests server time plus the current `SOLUSDT` mark price. If the local shell is not an authorized MCP client, show the explicit auth-required message rather than hiding it.
4. Show the risk step: the fixture is checked for direction, stop width, expiry and paper-only execution.
5. Show the final `PAPER_TRADE_PREVIEW` and the appended `data/submission-demo.ndjson` audit record.
6. Explain that the repository separates the analyst from the executor: the analyst proposes, MCP re-checks market state, and the executor can only simulate in this submission build.

For a one-shot live-data scan check on Windows, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-analysis.ps1 -Once
```

This command keeps the repository's proxy detection and exits after one scan; it does not place orders.

The fixture is deterministic and labelled as a demo fixture. It is not a recommendation or a claim about the live market.
