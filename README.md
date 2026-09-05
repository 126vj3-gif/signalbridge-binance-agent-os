# Altcoin Futures Bot（本机模拟盘）

这个版本只读取 Binance USDⓈ-M 公开行情，并在本地模拟执行分析端发来的交易信号。默认 `mode=paper`，不会读取 API 密钥，也不会提交真实订单。

## 两个角色如何配合

1. 分析端扫描大量 USDT 山寨币，生成包含 `id/symbol/side/entry/stop/target/expiresAt/analysis/source` 的标准信号。
2. 分析端通过 `POST http://127.0.0.1:18787/signal` 发送信号。
3. 本机执行端下一轮复核当前价格、信号有效期、止损止盈方向、价差/资金费率/持仓数/冷却时间/每日亏损上限，再决定是否模拟开仓。
4. 执行端把接受、拒绝、止盈和止损结果写入 `data/execution-results.ndjson`，并可通过 `GET /results?limit=50` 查询。

当前联合启动会运行三个进程：信号桥、本地分析端和模拟执行端。分析端扫描全市场符合条件的 USDT 永续合约，并对全部候选做多周期深度分析，再通过桥发送信号；执行端保持 `executionOnly=true`，不会自行开仓，只负责复核和执行分析信号；它仍会读取公开行情来更新已有模拟仓位。
执行端还会拒绝非 `local-upgraded-strategy` 来源的信号，以及止损距离超过 3% 的外部信号，避免旧扫描器或过宽止损放大单笔风险。
机器人带有单实例锁 `data/paper-bot.lock`，重复启动会直接退出，避免同一信号被并发执行两次。
分析端使用独立锁 `data/analysis-bot.lock`、状态文件 `data/analysis-state.json` 和信号文件 `data/analysis-signals.json`，不会覆盖执行端的持仓状态或信号文件。
模拟成交会使用盘口买一/卖一估算成交价，止盈止损使用盘口中间价检查，并计入配置中的滑点和双边手续费；这比单纯拿最新成交价计算更接近真实执行，但仍不等同于真实撮合。

扫描会覆盖成交量前 100 个、已运行至少 14 天的 USDT 永续合约，并过滤异常价差、过高资金费率和过低持仓量。模拟盘会计入估算手续费与滑点，按冷却时间、单笔风险、每日亏损上限和最大持仓数进行限制。

## 运行

```powershell
Copy-Item config.example.json config.json
$env:NODE_USE_ENV_PROXY="1"
$env:HTTPS_PROXY="http://127.0.0.1:7892"
npm run check
npm run scan
npm run paper
```

## 信号桥

本机桥接服务只监听 `127.0.0.1:18787`。分析端向 `POST /signal` 发送标准信号，机器人下一轮扫描时会重新核对当前价格、有效期、止损止盈方向、持仓数、冷却时间和每日亏损上限。重复信号会被去重，过期或价格偏离超过 1% 会拒绝。

```powershell
npm run bridge
```

信号示例（仅模拟盘）：

```powershell
$body = @{ id="demo-001"; symbol="SOLUSDT"; side="LONG"; entry=100; stop=98.5; target=103; expiresAt=(Get-Date).ToUniversalTime().AddMinutes(5).ToString("o"); analysis="example" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18787/signal -ContentType "application/json" -Body $body
```

状态文件写入 `data/paper-state.json`，信号写入 `data/latest-signals.json`。
执行反馈写入 `data/execution-results.ndjson`，供分析端读取。

## 安全边界

- 默认只做模拟盘。
- 不支持提现、转账或自动追加保证金。
- 单笔保证金、杠杆、持仓数、单日亏损上限均由配置限制。
- 价格偏离、数据缺失、重复信号和止损缺失时拒绝开仓。
- 资金费率、持仓量和盘口价差异常时拒绝开仓。
- 模拟持仓触及止盈/止损后自动平仓，并记录估算手续费、滑点和盈亏。
- 当前仍未实现实盘执行器；任何实盘切换都必须另行设计、测试和人工确认。
- 当前分析端与执行端通过本机信号桥配合；桥接服务默认只允许 `paper` 模式。
- 切换到实盘前必须单独完成 API 权限、IP 白名单、测试网验证和人工复核。
