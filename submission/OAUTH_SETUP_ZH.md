# Binance MCP 授权说明

## 当前已经验证的部分

当前 Codex 会话可以调用 Binance MCP 的只读行情工具。这个授权只存在于 MCP 客户端会话里，本地 Node 进程不会自动拿到同一份 OAuth 会话。

## 官方接入方式

1. 用桌面浏览器登录 Binance.com。
2. 在 Codex Desktop 或其他支持 MCP 的客户端中添加 Binance MCP Server。
3. 点击 Authenticate，登录并选择授权范围。
4. 看到 MCP 工具可以查询行情后，再运行项目 Demo。

```powershell
npm run demo:submission
```

官方 MCP 连接不要求你在设备上保存 API Key，也不要求把 OAuth Token 发给我。

## 本地脚本为什么可能仍显示 401

OAuth 会话保存在 MCP 客户端中，独立 Node 进程不会自动继承它。提交 Demo 时，直接在已授权的 MCP 客户端里展示 MCP 行情复核，再展示本项目的纸面交易预览即可；不要为了绕过 401 而复制或转交会话令牌。

## 交易权限

本项目默认只读和模拟盘。若活动评审明确要求真实交易，必须由你在 Binance MCP 客户端单独开启交易权限，并在每次真实下单前人工确认；提现权限永远不需要。
