# Binance MCP 赛道适配说明

## 当前已完成

- 本地分析端扫描全市场 USDT 永续合约。
- 分析结果通过标准化信号桥传给执行端。
- 新增 `src/binance-mcp-client.mjs`，支持 MCP JSON-RPC 初始化和 `tools/call`。
- 已覆盖 Binance USD-M Futures 的只读工具：交易对信息、24 小时行情、标记价格、K 线、持仓量、盘口和服务器时间。
- MCP 调用写入 `data/mcp-audit.ndjson`，可用于 Demo 回放和审计。
- 默认 `mode=paper`、`readOnly=true`、`allowTrading=false`，不会偷偷提交真实订单。

## Demo 流程

```text
全市场行情 → 本地分析策略 → 标准信号 → Binance MCP 市场复核 → 本地风控 → 模拟执行 → 审计反馈
```

## 运行 MCP 连通性检查

```powershell
$env:BINANCE_MCP_ENDPOINT = "官方 Binance MCP 服务地址"
npm run mcp:health
```

当前 Codex 环境中的 Binance MCP 工具已经可以执行只读服务器时间检查；直接从本地 Node 进程访问官方地址会返回 HTTP 401，因为官方 MCP 的授权会保存在 MCP 客户端会话中，不会自动暴露给本地脚本。要完成真实 MCP Demo，需要在 MCP 客户端里完成 Binance OAuth 登录，然后由该客户端调用 Binance 工具；本地分析端继续通过信号桥提供机会和风控数据。

## 活动合规边界

这份工程已经具备 MCP 客户端、市场分析、风控、模拟执行和审计展示所需的代码结构，但活动资格仍需要人工完成：关注/转发、回复提交作品、填写表单、提供 Demo/GitHub，以及按活动要求确认账号资格。官方审核结果不能由本地代码自行保证。
