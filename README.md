# TradePilot

TradePilot 是基于 [MiniClaw](https://github.com/helsome/miniclaw) 的跨境电商经营决策 Agent 本地原型。本仓库保留 MiniClaw 的 Agent Runtime、工作区、多渠道与能力管理基座，并增加经营数据调查、动作草案、人工审批和确定性回归用例。基座来源及原始说明见 [MiniClaw README](docs/UPSTREAM_MINICLAW_README.md)；原始版权与 MIT 许可见 [LICENSE](LICENSE)。

## 当前可运行范围

- 从本地 `ecommerce-data/` 的商品、销售、库存、广告、促销、成本 CSV 读取数据，通过只读工具调查 SKU、站点和时间窗。
- 对缺失日期、重复业务键、跨站 SKU、币种冲突、过期库存和毛利约束等情况进行校验；证据不足时停止高风险建议。
- 生成 `approval_required`、`executable: false` 的动作草案。认证用户可以在“经营审批”页面审核；真实电商平台的价格、广告、库存或 Listing 修改仍由人工在外部平台完成。
- 保存调查 Trace、草案和审批记录；用确定性工具/策略用例进行回归。该评测不代表模型端到端质量或线上业务收益。

目前**没有接入真实电商平台 API/MCP 连接器，也没有自动执行外部经营操作**。详细机制与边界见 [电商原型说明](docs/ECOMMERCE_AGENT_MVP.md)。

## 快速复现

按照上游 [MiniClaw README](docs/UPSTREAM_MINICLAW_README.md) 配置 Node.js 环境并安装依赖后，在仓库根目录运行：

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

本项目基于 MiniClaw 的 2026-08-18 快照（提交 `3ff1c8d6a0707f4a9f0957ff411758e5e141583a`）扩展。MiniClaw 原作者和贡献者保留其原有版权；本仓库的新增与修改部分请通过相对该提交的 diff 查看。仓库继续保留原 MIT 许可证。项目中的示例数据为合成样例，不应替换为真实客户资料后公开提交。
