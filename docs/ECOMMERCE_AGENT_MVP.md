# Ecommerce Decision Agent MVP

This MVP adds an opt-in, local-data decision workflow to the Agent Runner. It
does not connect to a production commerce account and cannot change price,
advertising budget, inventory, or listing state.

## Enable the tools

Copy the sample dataset into a workspace's canonical group directory:

```text
<workspace-group>/ecommerce-data/
  products.csv
  sales.csv
  inventory.csv
  ads.csv
  promotions.csv
  costs.csv
```

The Runner registers the ecommerce tool set only when that directory exists and
contains at least one expected CSV file. A tool call then validates all six
files; incomplete or malformed datasets fail closed with a structured error.
When the tools are registered, both Runner paths inject a required, versioned
`ecommerce-sop` PromptBlock into PromptPlan. The block tells the Agent to
investigate before drafting and never claim an action was executed.

Every query uses an explicit SKU and time window; `site` is required when the
same SKU exists at multiple sites. Dates must be real calendar dates and each
window is limited to 366 days. `products.csv` may have an optional
`bundle_components` column. A bundle SKU requires `costs.csv` to have an
explicit `cost_basis` of `bundle_total`; component costs are never guessed.
The CSV adapter rejects duplicate business keys before any query: product and
cost rows use site + SKU; sales and advertising use site + SKU + day; inventory
uses site + SKU + snapshot time. Identical promotion rows are also rejected.
This prevents repeated daily rows from silently inflating totals.
`products.csv` may additionally carry `list_price` and `price_currency` for
price-policy evaluation. `promotions.csv` may carry `currency`; fixed-amount
promotions must declare the same currency as the proposed price. Older CSV
files remain readable, but a price draft without these fields is rejected.

Sample files live in `examples/ecommerce-data/`.

## Tool workflow

```text
ecommerce_dataset_status
  -> ecommerce_monitor
  -> ecommerce_query_sales + ecommerce_query_inventory
  -> ecommerce_query_ads + ecommerce_calculate_profit
  -> ecommerce_investigate_sku
  -> ecommerce_compare_ad_budget_options
  -> ecommerce_draft_action
  -> ecommerce_action_status
  -> authenticated human decision in TradePilot approval page
  -> human operates external platform and records what they did
  -> ecommerce_review_windows (observational before/after comparison)
  -> authenticated human records the matching review Trace
```

All query and status tools are read-only. `ecommerce_draft_action` returns
`status: "approval_required"` and `executable: false`; it has no connector that
can perform an external side effect. A passing draft is atomically persisted in
`ecommerce-data/.actions/`, so `ecommerce_action_status` can recover it after a
Runner restart.

Sales and advertising evidence uses explicit daily coverage. Every date in the
requested inclusive window must have a row, including zero-activity days. A
missing date changes the investigation status to `needs_more_evidence` and is
listed in `missing_material` rather than being silently interpreted as zero.

Numeric action drafts carry both values and their business unit. Currency-based
actions also require a three-letter currency code. For example:

```json
{
  "action_type": "adjust_ad_budget",
  "current_value": 37.5,
  "proposed_value": 3,
  "unit": "currency_per_day",
  "currency": "USD",
  "status": "approval_required",
  "executable": false
}
```

Advertising-budget drafts additionally pass the code-level
`ad-budget-profit-guard-v1` policy. It requires complete sales and advertising
coverage, verifies the submitted current budget and currency against evidence,
and calculates this conservative daily limit:

```text
min(attributed sales * pre-ad contribution margin,
    total pre-ad contribution) / dates in window
```

For the sample `SKU-LOW` window the limit is approximately `3.04 USD/day`.
Therefore a proposal of `10 USD/day` fails closed, while `3 USD/day` may be
stored as a non-executable draft for human review.

The other action types now have conservative policy checks:

- `adjust_price` requires an active listing, explicit listed price/currency,
  matching observed current value, complete daily evidence, bundle cost basis
  where applicable, and a proposed price that stays above the _pre-ad_ unit
  break-even floor after all promotions active on each day in the window.
- `replenish_inventory` requires a complete investigation and an inventory
  snapshot no older than 24 hours at draft time. The current value must equal
  available units; an observed shortage after inbound units is required, and
  the proposed target cannot exceed the historical seven-day run rate.
- `pause_listing` requires an active listing, complete investigation, fresh
  inventory, and either observed negative profit or zero available stock.

These are guardrails for human review, not forecasts or claims that a price,
stock level, or listing decision is optimal. The Runner uses its current clock
for stock freshness; historical simulations can pass an explicit reference
time only through the local domain function, not the Agent tool schema.

Tool calls append a credential-free audit record to
`ecommerce-data/.traces/tool-traces.jsonl`. Trace persistence is best effort so
a read-only workspace can still be investigated; the tool result explicitly
reports when the trace could not be written. Action drafts require a persisted,
complete investigation Trace matching SKU, site, time window, current dataset
hash, and (when present) Runner session. Changing a CSV invalidates the Trace
for draft creation. Runner Traces include the current PromptPlan hash; the
draft tool also requires that hash to match the current Runner PromptPlan, so
a rule change requires a fresh investigation. The standalone CLI has no Runner
PromptPlan and records `null`; its investigation still writes a Trace and
returns its ID.
Each persisted draft also records its investigation window. Before approval,
the host checks every referenced Trace against the draft's SKU, site, window,
and the current six-file dataset hash, and requires one complete investigation
Trace. A changed CSV or mismatched window blocks approval even when the draft
file's displayed hash is current. These workspace Trace files are not signed;
the host does **not** independently recompute the Runner's business-policy
formulas, so approval is still a human governance decision, not a tamper-proof
financial attestation.

`ecommerce_compare_ad_budget_options` compares holding, reducing to the policy
limit, and pausing ad spend. Its profit figures hold sales and unit costs
constant and are illustrative, not forecasts. `ecommerce_review_windows`
reports observed differences across two non-overlapping windows of equal length; it cannot
prove that an action was approved, executed, or caused the difference.

## Human decision gate

After the Agent writes a draft, open **经营审批** in the desktop/web sidebar.
Select the workspace, inspect the proposal and its Trace IDs, enter a reason,
then approve or reject. The authenticated workspace owner (or a host-execution
administrator with access) is the reviewer. Other users cannot list or decide
these drafts. The backend stores the reviewer, timestamp, reason, decision,
workspace, and SHA-256 hash of the exact draft bytes in SQLite schema v71,
outside the Agent workspace. Decisions are one-time records: a second decision
returns HTTP 409. The browser submits the hash it displayed, so a draft
changed between display and submission also returns HTTP 409. If the draft
changes after review, the page flags the previous decision as inapplicable.
The server refuses approval of legacy `schema_only` drafts or drafts with a
missing/mismatched policy version; a reviewer can still reject them. This
checks the recorded policy result, not an independently signed platform audit.

This is an approval record, **not** permission for the Agent to execute an
external change. There is still no price, ad, inventory, or listing mutation
connector. The Agent does not receive an approve/reject tool.

After approval, a human may record an external operation timestamp, platform
reference, and explanation. This is a self-reported record, not proof that the
platform performed the change. It is accepted only for the same approved draft
hash and cannot be overwritten. The Agent can then call the read-only
`ecommerce_review_windows` tool for equal-length, non-overlapping windows.
The reported operation time must be after approval; review windows exclude
the operation's UTC calendar day.
The page accepts its Trace ID only when SKU, site, current CSV dataset hash,
window chronology, and computed deltas are consistent, and persists a linked
review snapshot in server SQLite. The Agent workspace Trace is not signed or
tamper-proof, so this is a human-confirmed observation, not an independent
audit or a causal result. There remains no automated external execution.

## CLI

Inspect the sample data:

```bash
npm run ecommerce:cli -- status --data-dir examples/ecommerce-data
```

Run a complete SKU investigation:

```bash
npm run ecommerce:cli -- investigate \
  --data-dir examples/ecommerce-data \
  --sku-id SKU-LOW \
  --site US \
  --start-date 2026-09-01 \
  --end-date 2026-09-07 \
  --reference-time 2026-09-08T12:00:00Z
```

Run a read-only monitor or comparison:

```bash
npm run ecommerce:cli -- monitor --data-dir examples/ecommerce-data --site US \
  --start-date 2026-09-01 --end-date 2026-09-07 \
  --reference-time 2026-09-08T12:00:00Z
npm run ecommerce:cli -- compare-ad-budget --data-dir examples/ecommerce-data \
  --sku-id SKU-LOW --site US --start-date 2026-09-01 \
  --end-date 2026-09-07 --reference-time 2026-09-08T12:00:00Z
```

The deterministic regression suite covers complete evidence, missing or
duplicate days,
stale inventory, cross-site SKU ambiguity, invalid dates, currency conflict,
overlapping promotions, bundle cost basis, profit policy rejection, mismatched
or stale Trace, and the absence of approve/execute Tools. It is a tool-contract
eval, not a measured LLM answer-quality benchmark.

Run the repeatable scenario gate with:

```bash
npm run ecommerce:eval
```

It emits a JSON report with fourteen normal, abnormal, ambiguous, and safety cases,
each case's expected/observed status, evidence filenames, and dataset hash.
Any failed case exits with status 1; a broken fixture or invocation exits with
status 2. `--fixture-dir <path>` can point to a copy of the same six-file sample
contract for regression experiments. The report explicitly says
`model_answer_quality_measured: false`: this is a deterministic Tool/Policy
evaluation, not an LLM response benchmark or production success metric.

To score structured answers captured from a model or another Agent run, list
the five response scenarios and submit a JSON answer array:

```bash
npm run ecommerce:response-eval -- --list-cases
npm run ecommerce:response-eval -- --responses examples/ecommerce-response-eval-pass.json
```

The replay gate checks scope, evidence references, disposition, action boundary,
and unsupported approval/execution claims. The bundled passing file is a
synthetic example, **not a live model run**; this command never calls a model
and cannot measure free-text factual quality or generalization by itself.

An opt-in synthetic model check can send the same five cases through the
configured Pi provider with tools disabled:

```bash
npm run ecommerce:live-eval -- --confirm-live
```

It may incur model charges and is never run by `self-test`. Without
`--confirm-live`, it exits before sending a request. Its report identifies
`synthetic_live_model_no_tools`, keeps raw model text out of the report, and
counts missing or malformed replies as failures. Passing this check would
measure only these synthetic structured answers, **not** the full tool-calling
Agent workflow or production accuracy.

## Boundaries

### Resume claim status (2026-09-28)

| Claim                            | Current evidence                                                                                                                                                               | Status                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Commerce data MCP Hub            | Local CSV adapter and read-only `ecommerce_*` tools in `ecommerce-tools.ts`; configured MCP layering exists in the platform                                                    | Local prototype; no live commerce MCP adapter                               |
| Harness and Tool Calling         | Zod schemas, `createMcpTools`, investigation order, action-specific policy-gated drafts                                                                                        | Implemented for local data with conservative guardrails                     |
| Context Engineering              | Required `ecommerce-sop` PromptBlock in both Runner paths, with PromptPlan hash and budget guard; Runner Trace stores the plan hash and action drafts reject a mismatched plan | Implemented for local Runner turns                                          |
| Runtime isolation and recovery   | Existing Pi Runner stdin/stdout and IPC lifecycle, with ecommerce tools registered per workspace                                                                               | Platform capability; not new ecommerce-specific runtime code                |
| Agent Eval                       | Deterministic Tool/Policy gate, structured replay gate, and opt-in synthetic no-tools model runner                                                                             | Live runner is available but not yet measured here; no full Agent benchmark |
| Human approval and action review | Authenticated workspace-scoped decision API/UI, immutable SQLite decision, manual-operation and outcome-review records, observational before/after comparison                  | Local human workflow implemented; external execution not implemented        |

The repository demonstrates project capabilities; it does not by itself prove
which contributor personally implemented each part.

- CSV is the first Adapter, not proof of a live ERP or advertising connector.
- The Agent may investigate and draft actions. An authenticated human may
  approve or reject a specific draft in the UI, but actual execution remains
  deliberately absent.
- The Agent has no approval, rejection, or execution tool. Draft files keep
  `approval_required` and `executable: false`; human decisions live separately
  in the server-owned SQLite ledger.
- The local CSV adapter is not the `loadClaudeContextMcpServers` or
  `mergeMcpServerLayers` connector path. Those existing functions resolve
  configured MCP servers; a real commerce API adapter and its credentials are
  still future work.
- CTR and CPC remain observations unless an explicit benchmark is added; the
  Agent must not label them normal or abnormal from these files alone.
- The dataset contains no secrets. Real connectors must keep credentials out of
  Prompt, tool results, traces, and workspace files.
