#!/usr/bin/env tsx
import path from 'node:path';

import {
  calculateProfit,
  compareAdBudgetOptions,
  assertEvidenceTracesExist,
  draftGovernedAction,
  investigateSku,
  loadEcommerceDataset,
  monitorEcommerce,
  parseEcommerceActionUnit,
  parseEcommerceActionType,
  persistActionDraft,
  queryAds,
  queryInventory,
  querySales,
  readActionDraft,
  recordEcommerceTrace,
  reviewEcommerceWindows,
} from '../container/agent-runner/src/ecommerce-tools.js';

type ParsedArgs = Record<string, string | boolean>;

function parseArgs(values: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(args: ParsedArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required option --${key}`);
  }
  return value.trim();
}

function optional(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function printHelp(): void {
  process.stdout.write(`Ecommerce decision-agent CLI

Usage:
  npm run ecommerce:cli -- <command> [options]

Commands:
  status
  monitor
  sales
  inventory
  ads
  profit
  investigate
  compare-ad-budget
  review-windows
  draft-action
  action-status

Common query options:
  --data-dir <path>       Defaults to ./ecommerce-data
  --sku-id <id>
  --site <site>
  --start-date <YYYY-MM-DD>
  --end-date <YYYY-MM-DD>
  --after-start-date <YYYY-MM-DD>  For review-windows
  --after-end-date <YYYY-MM-DD>    For review-windows

Investigation options:
  --reference-time <ISO timestamp>

Draft options:
  --action-type <adjust_price|adjust_ad_budget|replenish_inventory|pause_listing>
  --reason <text>
  --evidence-trace-ids <comma-separated ids>
  --current-value <number>
  --proposed-value <number>
  --unit <currency_per_day|currency_per_unit|units|listing_state>
  --currency <ISO 4217 code, required for currency units>

Action status options:
  --action-id <persisted action id>
`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }
  const args = parseArgs(rest);
  const dataDir = path.resolve(optional(args, 'data-dir') ?? 'ecommerce-data');
  const dataset = loadEcommerceDataset(dataDir);
  const skuId = optional(args, 'sku-id');
  const site = optional(args, 'site');
  const startDate = optional(args, 'start-date');
  const endDate = optional(args, 'end-date');
  const window = () => ({
    skuId: skuId ?? required(args, 'sku-id'),
    site,
    startDate: startDate ?? required(args, 'start-date'),
    endDate: endDate ?? required(args, 'end-date'),
  });

  let output: unknown;
  switch (command) {
    case 'status':
      output = {
        data_dir: dataDir,
        row_counts: Object.fromEntries(
          Object.entries(dataset).map(([name, rows]) => [name, rows.length]),
        ),
      };
      break;
    case 'sales':
      output = querySales(dataset, window());
      break;
    case 'monitor':
      output = monitorEcommerce(
        dataset,
        {
          site,
          startDate: startDate ?? required(args, 'start-date'),
          endDate: endDate ?? required(args, 'end-date'),
        },
        optional(args, 'reference-time') ?? new Date().toISOString(),
      );
      break;
    case 'inventory':
      output = queryInventory(dataset, skuId ?? required(args, 'sku-id'), site);
      break;
    case 'ads':
      output = queryAds(dataset, window());
      break;
    case 'profit':
      output = calculateProfit(dataset, window());
      break;
    case 'investigate': {
      const result = investigateSku(
        dataset,
        window(),
        optional(args, 'reference-time') ?? new Date().toISOString(),
      );
      output = {
        data: result,
        trace: recordEcommerceTrace(
          { dataDir },
          'ecommerce_investigate_sku',
          result,
        ),
      };
      break;
    }
    case 'compare-ad-budget':
      output = compareAdBudgetOptions(
        dataset,
        window(),
        optional(args, 'reference-time') ?? new Date().toISOString(),
      );
      break;
    case 'review-windows':
      output = reviewEcommerceWindows(dataset, window(), {
        skuId: skuId ?? required(args, 'sku-id'),
        site: site ?? required(args, 'site'),
        startDate: required(args, 'after-start-date'),
        endDate: required(args, 'after-end-date'),
      });
      break;
    case 'draft-action': {
      const currentValue = optional(args, 'current-value');
      const proposedValue = optional(args, 'proposed-value');
      const evidenceTraceIds = required(args, 'evidence-trace-ids')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const query = window();
      assertEvidenceTracesExist(dataDir, evidenceTraceIds, {
        skuId: query.skuId,
        site: site ?? required(args, 'site'),
        startDate: query.startDate,
        endDate: query.endDate,
      });
      output = persistActionDraft(
        dataDir,
        draftGovernedAction(
          dataset,
          {
            skuId: skuId ?? required(args, 'sku-id'),
            site: site ?? required(args, 'site'),
            actionType: parseEcommerceActionType(required(args, 'action-type')),
            unit: parseEcommerceActionUnit(required(args, 'unit')),
            currency: optional(args, 'currency'),
            reason: required(args, 'reason'),
            evidenceTraceIds,
            currentValue:
              currentValue === undefined ? undefined : Number(currentValue),
            proposedValue:
              proposedValue === undefined ? undefined : Number(proposedValue),
          },
          window(),
        ),
      );
      break;
    }
    case 'action-status': {
      output = readActionDraft(dataDir, required(args, 'action-id'));
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
