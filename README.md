# TradePilot

TradePilot 是一个跨境电商经营决策 Agent 本地原型。它通过商品、销售、库存、广告、促销和成本数据调查经营问题，生成带证据的动作草案，并将业务操作交由人工审批。当前仓库提供可复现的本地数据样例、调查工具和确定性回归用例。

## 当前可运行范围

- 从本地 `ecommerce-data/` 的商品、销售、库存、广告、促销、成本 CSV 读取数据，通过只读工具调查 SKU、站点和时间窗。
- 对缺失日期、重复业务键、跨站 SKU、币种冲突、过期库存和毛利约束等情况进行校验；证据不足时停止高风险建议。
- 生成 `approval_required`、`executable: false` 的动作草案。认证用户可以在“经营审批”页面审核；真实电商平台的价格、广告、库存或 Listing 修改仍由人工在外部平台完成。
- 保存调查 Trace、草案和审批记录；用确定性工具/策略用例进行回归。该评测不代表模型端到端质量或线上业务收益。

目前**没有接入真实电商平台 API/MCP 连接器，也没有自动执行外部经营操作**。详细机制与边界见 [电商原型说明](docs/ECOMMERCE_AGENT_MVP.md)。

## 快速复现

使用 Node.js 20 或更高版本，在仓库根目录运行 `npm install`，然后执行：

```bash
npm run ecommerce:cli -- status --data-dir examples/ecommerce-data
npm run ecommerce:cli -- investigate --data-dir examples/ecommerce-data --sku-id SKU-LOW --site US --start-date 2026-09-01 --end-date 2026-09-07 --reference-time 2026-09-08T12:00:00Z
npm run ecommerce:eval
```

`ecommerce:eval` 是离线确定性门禁；`ecommerce:live-eval -- --confirm-live` 会调用已配置的模型并可能产生费用，不属于上述快速复现步骤。

## 代码导航

| 范围 | 入口 |
|---|---|
| 本地数据适配、调查、策略和工具 | `container/agent-runner/src/ecommerce-tools.ts` |
| Agent 工具装配与 PromptPlan | `container/agent-runner/src/mcp-tools.ts`、`container/agent-runner/src/prompt-plan.ts` |
| 审批记录与接口 | `src/ecommerce-approval-store.ts`、`src/routes/workspaces.ts` |
| 经营审批页面 | `web/src/pages/TradePilotPage.tsx` |
| 回归用例 | `scripts/ecommerce-eval-core.ts`、`tests/ecommerce-tools.test.ts` |

## 来源与许可

TradePilot 的 Agent 工作台基座来自 MiniClaw 的 2026-08-18 快照（提交 `3ff1c8d6a0707f4a9f0957ff411758e5e141583a`）；原仓库地址当前无法公开访问。保留的[原始说明副本](docs/UPSTREAM_MINICLAW_README.md)和 [MIT 许可证](LICENSE)记录了基座来源与原作者版权。TradePilot 新增的电商场景实现可通过本仓库的两个提交对比查看。项目中的示例数据为合成样例，不应替换为真实客户资料后公开提交。
