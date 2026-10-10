import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  calculateProfit,
  compareAdBudgetOptions,
  createEcommerceTools,
  draftAction,
  draftGovernedAction,
  investigateSku,
  loadEcommerceDataset,
  monitorEcommerce,
  parseEcommerceActionType,
  queryAds,
  queryInventory,
  querySales,
  readActionDraft,
  reviewEcommerceWindows,
} from '../container/agent-runner/src/ecommerce-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';

const requiredFiles = [
  'products.csv',
  'sales.csv',
  'inventory.csv',
  'ads.csv',
  'promotions.csv',
  'costs.csv',
] as const;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-ecommerce-'));
const dataDir = path.join(tempRoot, 'ecommerce-data');
const exampleDir = path.resolve('examples/ecommerce-data');

function copyDataset(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const filename of requiredFiles) {
    fs.copyFileSync(
      path.join(exampleDir, filename),
      path.join(targetDir, filename),
    );
  }
}

beforeAll(() => copyDataset(dataDir));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('ecommerce decision-agent domain', () => {
  test.each(requiredFiles)(
    'rejects duplicate business keys in %s',
    (filename) => {
      const duplicateDir = path.join(tempRoot, `duplicate-${filename}`);
      copyDataset(duplicateDir);
      const file = path.join(duplicateDir, filename);
      const firstRow = fs
        .readFileSync(file, 'utf8')
        .trimEnd()
        .split(/\r?\n/)[1];
      fs.appendFileSync(file, `${firstRow}\n`);

      expect(() => loadEcommerceDataset(duplicateDir)).toThrow(
        new RegExp(
          `${filename.replace('.', '\\.')} row \\d+: duplicate business key`,
        ),
      );
    },
  );

  test('aggregates sales, inventory, ads, and contribution profit', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const window = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };

    expect(querySales(dataset, window)).toMatchObject({
      units: 9,
      revenue: 180,
      currency: 'USD',
      row_count: 7,
      date_coverage: {
        expected_date_count: 7,
        observed_date_count: 7,
        coverage_ratio: 1,
        missing_dates: [],
        complete: true,
      },
    });
    expect(queryInventory(dataset, 'SKU-LOW', 'US')).toMatchObject({
      available: 4,
      inbound: 0,
      reserved: 1,
    });
    expect(queryAds(dataset, window)).toMatchObject({
      spend: 75,
      current_daily_budget: 37.5,
      budget_captured_on: '2026-09-07',
      attributed_sales: 85,
      row_count: 7,
      date_coverage: {
        expected_date_count: 7,
        observed_date_count: 7,
        coverage_ratio: 1,
        missing_dates: [],
        complete: true,
      },
    });
    expect(calculateProfit(dataset, window)).toMatchObject({
      product_cost: 81,
      fulfillment_cost: 27,
      platform_fee: 27,
      ad_spend: 75,
      profit: -30,
      margin: -1 / 6,
      currency: 'USD',
    });
  });

  test('runs the evidence sequence and detects business constraints', () => {
    const result = investigateSku(
      loadEcommerceDataset(dataDir),
      {
        skuId: 'SKU-LOW',
        site: 'US',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      },
      '2026-09-08T12:00:00Z',
    );

    expect(result.status).toBe('ready_for_recommendation');
    expect(result.warnings).toEqual([]);
    expect(result.missing_material).toEqual([]);
    expect(result.claim_constraints).toContain(
      'Do not classify CTR or CPC as normal or abnormal without an explicit benchmark.',
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        'negative_margin',
        'low_ad_roas',
        'inventory_below_seven_day_run_rate',
        'overlapping_promotions',
      ]),
    );
  });

  test('returns a partial result when daily evidence coverage is incomplete', () => {
    const incompleteDir = path.join(tempRoot, 'incomplete-coverage');
    copyDataset(incompleteDir);
    fs.writeFileSync(
      path.join(incompleteDir, 'sales.csv'),
      [
        'date,sku_id,site,units,revenue,currency',
        '2026-09-01,SKU-LOW,US,5,100,USD',
        '2026-09-02,SKU-LOW,US,4,80,USD',
        '',
      ].join('\n'),
    );

    const result = investigateSku(
      loadEcommerceDataset(incompleteDir),
      {
        skuId: 'SKU-LOW',
        site: 'US',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      },
      '2026-09-08T12:00:00Z',
    );

    expect(result.status).toBe('needs_more_evidence');
    expect(result.warnings).toContain('sales_date_coverage_incomplete');
    expect(result.sales.date_coverage).toMatchObject({
      expected_date_count: 7,
      observed_date_count: 2,
      coverage_ratio: 2 / 7,
      missing_dates: [
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-06',
        '2026-09-07',
      ],
      complete: false,
    });
    expect(result.missing_material).toContain(
      'sales.csv:US:SKU-LOW:2026-09-03',
    );
  });

  test('fails closed when evidence is stale or currencies conflict', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const stale = investigateSku(
      dataset,
      {
        skuId: 'SKU-LOW',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      },
      '2026-09-10T12:00:00Z',
    );
    expect(stale.status).toBe('needs_more_evidence');
    expect(stale.warnings).toContain('inventory_data_is_stale');

    const conflictDir = path.join(tempRoot, 'currency-conflict');
    copyDataset(conflictDir);
    fs.writeFileSync(
      path.join(conflictDir, 'costs.csv'),
      [
        'sku_id,site,currency,unit_cost,fulfillment_cost,platform_fee_rate',
        'SKU-LOW,US,CNY,9,3,0.15',
        'SKU-HEALTHY,US,USD,8,2,0.15',
        '',
      ].join('\n'),
    );
    expect(() =>
      calculateProfit(loadEcommerceDataset(conflictDir), {
        skuId: 'SKU-LOW',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      }),
    ).toThrow(/Currency mismatch/);
  });

  test('rejects impossible dates and ambiguous cross-site SKUs', () => {
    const dataset = loadEcommerceDataset(dataDir);
    expect(() =>
      querySales(dataset, {
        skuId: 'SKU-LOW',
        site: 'US',
        startDate: '2026-02-30',
        endDate: '2026-03-01',
      }),
    ).toThrow(/valid YYYY-MM-DD/);

    const multiSiteDir = path.join(tempRoot, 'multi-site');
    copyDataset(multiSiteDir);
    fs.appendFileSync(
      path.join(multiSiteDir, 'products.csv'),
      'SKU-LOW,UK,Travel Bottle UK,active,20,GBP\n',
    );
    const multiSite = loadEcommerceDataset(multiSiteDir);
    expect(() =>
      querySales(multiSite, {
        skuId: 'SKU-LOW',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      }),
    ).toThrow(/site is required/);
    expect(
      querySales(multiSite, {
        skuId: 'SKU-LOW',
        site: 'US',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      }).units,
    ).toBe(9);
    expect(() =>
      querySales(dataset, {
        skuId: 'SKU-LOW',
        site: 'US',
        startDate: '2025-01-01',
        endDate: '2026-09-07',
      }),
    ).toThrow(/366 days/);
  });

  test('requires an explicit total cost for a bundle SKU', () => {
    const bundleDir = path.join(tempRoot, 'bundle-cost');
    copyDataset(bundleDir);
    fs.writeFileSync(
      path.join(bundleDir, 'products.csv'),
      [
        'sku_id,site,title,status,bundle_components',
        'SKU-LOW,US,Travel Bottle,active,',
        'SKU-HEALTHY,US,Desk Organizer,active,',
        'BUNDLE-1,US,Travel Kit,active,SKU-LOW*2',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(bundleDir, 'costs.csv'),
      [
        'sku_id,site,currency,unit_cost,fulfillment_cost,platform_fee_rate,cost_basis',
        'SKU-LOW,US,USD,9,3,0.15,sku_unit',
        'SKU-HEALTHY,US,USD,8,2,0.15,sku_unit',
        'BUNDLE-1,US,USD,18,4,0.15,sku_unit',
        '',
      ].join('\n'),
    );
    const window = {
      skuId: 'BUNDLE-1',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };
    expect(() =>
      calculateProfit(loadEcommerceDataset(bundleDir), window),
    ).toThrow(/requires explicit bundle_total cost_basis/);
    fs.writeFileSync(
      path.join(bundleDir, 'costs.csv'),
      [
        'sku_id,site,currency,unit_cost,fulfillment_cost,platform_fee_rate,cost_basis',
        'SKU-LOW,US,USD,9,3,0.15,sku_unit',
        'SKU-HEALTHY,US,USD,8,2,0.15,sku_unit',
        'BUNDLE-1,US,USD,18,4,0.15,bundle_total',
        '',
      ].join('\n'),
    );
    expect(
      calculateProfit(loadEcommerceDataset(bundleDir), window).currency,
    ).toBe('USD');
  });

  test('monitors data gaps and compares budget scenarios without claiming a forecast', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const window = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };
    const alerts = monitorEcommerce(
      dataset,
      window,
      '2026-09-08T12:00:00Z',
    ).alerts;
    expect(alerts).toContainEqual(
      expect.objectContaining({
        sku_id: 'SKU-LOW',
        status: 'ready_for_recommendation',
        findings: expect.arrayContaining([
          'negative_margin',
          'overlapping_promotions',
        ]),
      }),
    );
    const comparison = compareAdBudgetOptions(
      dataset,
      window,
      '2026-09-08T12:00:00Z',
    );
    expect(comparison.status).toBe('ready_for_comparison');
    expect(comparison.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          option: 'hold',
          policy_status: 'above_limit',
        }),
        expect.objectContaining({
          option: 'reduce_to_policy_limit',
          daily_budget: 3.03,
          policy_status: 'within_limit',
        }),
      ]),
    );
    expect(comparison.assumption).toMatch(/not forecasts/);
    expect(
      compareAdBudgetOptions(dataset, window, '2026-09-10T12:00:00Z'),
    ).toMatchObject({
      status: 'needs_more_evidence',
      options: [],
    });
  });

  test('does not call sequential promotions overlapping', () => {
    const sequentialDir = path.join(tempRoot, 'sequential-promotions');
    copyDataset(sequentialDir);
    fs.writeFileSync(
      path.join(sequentialDir, 'promotions.csv'),
      [
        'sku_id,site,start_date,end_date,discount_type,discount_value',
        'SKU-LOW,US,2026-09-01,2026-09-03,percentage,10',
        'SKU-LOW,US,2026-09-04,2026-09-07,fixed,2',
        '',
      ].join('\n'),
    );
    const result = investigateSku(
      loadEcommerceDataset(sequentialDir),
      {
        skuId: 'SKU-LOW',
        site: 'US',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
      },
      '2026-09-08T12:00:00Z',
    );
    expect(result.findings).not.toContain('overlapping_promotions');
  });

  test('reviews non-overlapping windows without inferring an executed action', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const before = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
    };
    const after = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-05',
      endDate: '2026-09-07',
    };
    const review = reviewEcommerceWindows(dataset, before, after);
    expect(review.status).toBe('observed');
    expect(review.delta.profit).toBeCloseTo(
      review.after.profit - review.before.profit,
    );
    expect(review.limitation).toMatch(
      /do not establish.*approved, executed, or caused/,
    );
    expect(() =>
      reviewEcommerceWindows(dataset, before, {
        ...after,
        startDate: '2026-09-03',
      }),
    ).toThrow(/must not overlap/);
    expect(() =>
      reviewEcommerceWindows(dataset, before, {
        ...after,
        startDate: '2026-09-04',
      }),
    ).toThrow(/same number of days/);
    expect(() =>
      reviewEcommerceWindows(dataset, before, { ...after, site: 'UK' }),
    ).toThrow(/same sku_id and site/);
  });

  test('creates approval-only drafts and rejects invalid CLI action values', () => {
    const actionType = parseEcommerceActionType('adjust_ad_budget');
    const draft = draftAction({
      skuId: 'SKU-LOW',
      site: 'US',
      actionType,
      unit: 'currency_per_day',
      currency: 'usd',
      reason: 'Negative margin and low advertising return',
      evidenceTraceIds: ['trace-sales', 'trace-profit'],
      currentValue: 37.5,
      proposedValue: 3,
    });

    expect(draft).toMatchObject({
      site: 'US',
      action_type: 'adjust_ad_budget',
      current_value: 37.5,
      proposed_value: 3,
      unit: 'currency_per_day',
      currency: 'USD',
      status: 'approval_required',
      executable: false,
    });
    expect(() => parseEcommerceActionType('delete_campaign')).toThrow(
      /Invalid action_type/,
    );
    expect(() =>
      draftAction({
        skuId: 'SKU-LOW',
        site: 'US',
        actionType,
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Invalid numeric input',
        evidenceTraceIds: ['trace-profit'],
        currentValue: 37.5,
        proposedValue: Number.NaN,
      }),
    ).toThrow(/finite number/);
    expect(() =>
      draftAction({
        skuId: 'SKU-LOW',
        site: 'US',
        actionType,
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'No supporting trace',
        evidenceTraceIds: [],
        currentValue: 37.5,
        proposedValue: 3,
      }),
    ).toThrow(/evidence_trace_id/);
    expect(() =>
      draftAction({
        skuId: 'SKU-LOW',
        site: 'US',
        actionType,
        unit: 'currency_per_unit',
        currency: 'USD',
        reason: 'Wrong unit',
        evidenceTraceIds: ['trace-profit'],
        currentValue: 37.5,
        proposedValue: 3,
      }),
    ).toThrow(/requires unit currency_per_day/);
  });

  test('enforces the advertising profit guard before creating a draft', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const input = {
      skuId: 'SKU-LOW',
      site: 'US',
      actionType: 'adjust_ad_budget' as const,
      unit: 'currency_per_day' as const,
      currency: 'USD',
      reason: 'Limit advertising loss',
      evidenceTraceIds: ['trace-profit'],
      currentValue: 37.5,
    };
    const window = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };

    expect(() =>
      draftGovernedAction(dataset, { ...input, proposedValue: 10 }, window),
    ).toThrow(/maximum daily budget 3.04 USD/);
    expect(() =>
      draftGovernedAction(
        dataset,
        { ...input, currentValue: 10, proposedValue: 3 },
        window,
      ),
    ).toThrow(/match the latest observed daily budget 37.5/);

    const draft = draftGovernedAction(
      dataset,
      { ...input, proposedValue: 3 },
      window,
    );
    expect(draft).toMatchObject({
      proposed_value: 3,
      status: 'approval_required',
      executable: false,
      policy: {
        policy_status: 'allowed',
        policy_version: 'ad-budget-profit-guard-v1',
        pre_ad_contribution: 45,
        pre_ad_margin_rate: 0.25,
        attributed_contribution_cap: 21.25,
        overall_break_even_cap: 45,
      },
    });
    expect(draft.policy.max_daily_budget).toBeCloseTo(21.25 / 7);
  });

  test('rejects an advertising draft when daily evidence is incomplete', () => {
    const incompleteDir = path.join(tempRoot, 'incomplete-policy');
    copyDataset(incompleteDir);
    fs.writeFileSync(
      path.join(incompleteDir, 'ads.csv'),
      [
        'date,sku_id,site,daily_budget,spend,impressions,clicks,attributed_sales,currency',
        '2026-09-01,SKU-LOW,US,37.5,40,1000,35,45,USD',
        '',
      ].join('\n'),
    );
    expect(() =>
      draftGovernedAction(
        loadEcommerceDataset(incompleteDir),
        {
          skuId: 'SKU-LOW',
          site: 'US',
          actionType: 'adjust_ad_budget',
          unit: 'currency_per_day',
          currency: 'USD',
          reason: 'Incomplete evidence must fail closed',
          evidenceTraceIds: ['trace-profit'],
          currentValue: 37.5,
          proposedValue: 3,
        },
        {
          skuId: 'SKU-LOW',
          site: 'US',
          startDate: '2026-09-01',
          endDate: '2026-09-07',
        },
      ),
    ).toThrow(/daily evidence coverage is incomplete/);
  });

  test('guards price changes against observed listing price and stacked promotions', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const window = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };
    const input = {
      skuId: 'SKU-LOW',
      site: 'US',
      actionType: 'adjust_price' as const,
      unit: 'currency_per_unit' as const,
      currency: 'USD',
      reason: 'Review price against unit contribution',
      evidenceTraceIds: ['trace-investigation'],
      currentValue: 20,
      proposedValue: 18,
    };
    expect(draftGovernedAction(dataset, input, window)).toMatchObject({
      executable: false,
      policy: {
        policy_status: 'allowed',
        policy_version: 'price-promotion-floor-v1',
      },
    });
    expect(() =>
      draftGovernedAction(dataset, { ...input, proposedValue: 17 }, window),
    ).toThrow(/promotional price below the pre-ad break-even floor/);
    expect(() =>
      draftGovernedAction(dataset, { ...input, currentValue: 19 }, window),
    ).toThrow(/current_value must match the listed price/);

    const legacyDir = path.join(tempRoot, 'legacy-price-fields');
    copyDataset(legacyDir);
    fs.writeFileSync(
      path.join(legacyDir, 'products.csv'),
      [
        'sku_id,site,title,status',
        'SKU-LOW,US,Travel Bottle,active',
        'SKU-HEALTHY,US,Desk Organizer,active',
        '',
      ].join('\n'),
    );
    expect(() =>
      draftGovernedAction(loadEcommerceDataset(legacyDir), input, window),
    ).toThrow(/requires list_price and price_currency/);

    const noPromoCurrencyDir = path.join(tempRoot, 'legacy-promotion-currency');
    copyDataset(noPromoCurrencyDir);
    fs.writeFileSync(
      path.join(noPromoCurrencyDir, 'promotions.csv'),
      [
        'sku_id,site,start_date,end_date,discount_type,discount_value',
        'SKU-LOW,US,2026-09-03,2026-09-07,fixed,2',
        '',
      ].join('\n'),
    );
    expect(() =>
      draftGovernedAction(
        loadEcommerceDataset(noPromoCurrencyDir),
        input,
        window,
      ),
    ).toThrow(/matching currency for each fixed promotion/);
  });

  test('guards replenishment targets with fresh inventory and covered demand', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const window = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };
    const input = {
      skuId: 'SKU-LOW',
      site: 'US',
      actionType: 'replenish_inventory' as const,
      unit: 'units' as const,
      reason: 'Recover seven-day stock cover',
      evidenceTraceIds: ['trace-investigation'],
      currentValue: 4,
      proposedValue: 9,
    };
    const referenceTime = '2026-09-08T12:00:00Z';
    expect(
      draftGovernedAction(dataset, input, window, referenceTime),
    ).toMatchObject({
      executable: false,
      policy: {
        policy_status: 'allowed',
        policy_version: 'inventory-seven-day-cover-v1',
      },
    });
    expect(() =>
      draftGovernedAction(
        dataset,
        { ...input, proposedValue: 20 },
        window,
        referenceTime,
      ),
    ).toThrow(/seven-day demand cap/);
    expect(() =>
      draftGovernedAction(
        dataset,
        { ...input, currentValue: 5 },
        window,
        referenceTime,
      ),
    ).toThrow(/current_value must match available inventory/);
    expect(() =>
      draftGovernedAction(dataset, input, window, '2026-09-10T12:00:00Z'),
    ).toThrow(/inventory snapshot is stale/);
  });

  test('permits listing-pause drafts only for an active listing with a measured risk', () => {
    const dataset = loadEcommerceDataset(dataDir);
    const window = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };
    const input = {
      skuId: 'SKU-LOW',
      site: 'US',
      actionType: 'pause_listing' as const,
      unit: 'listing_state' as const,
      reason: 'Investigate negative margin',
      evidenceTraceIds: ['trace-investigation'],
    };
    expect(
      draftGovernedAction(dataset, input, window, '2026-09-08T12:00:00Z'),
    ).toMatchObject({
      executable: false,
      policy: {
        policy_status: 'allowed',
        policy_version: 'listing-pause-risk-v1',
      },
    });
    expect(() =>
      draftGovernedAction(
        dataset,
        { ...input, skuId: 'SKU-HEALTHY' },
        { ...window, skuId: 'SKU-HEALTHY' },
        '2026-09-08T12:00:00Z',
      ),
    ).toThrow(/no measured margin or stock risk/);
  });
});

describe('ecommerce MCP integration', () => {
  test('requires the investigation trace to use the current PromptPlan', async () => {
    const planDir = path.join(tempRoot, 'prompt-plan-trace');
    copyDataset(planDir);
    let promptPlanHash = 'plan-v1';
    const tools = createEcommerceTools({
      dataDir: planDir,
      sessionId: 'session-plan-test',
      getPromptPlanHash: () => promptPlanHash,
    });
    const investigate = tools.find(
      (tool) => tool.name === 'ecommerce_investigate_sku',
    )!;
    const draft = tools.find((tool) => tool.name === 'ecommerce_draft_action')!;
    const investigationArgs = {
      sku_id: 'SKU-LOW',
      site: 'US',
      start_date: '2026-09-01',
      end_date: '2026-09-07',
      reference_time: '2026-09-08T12:00:00Z',
    };
    const first = await investigate.handler(investigationArgs, {});
    const firstTrace = JSON.parse(first.content[0].text).trace
      .trace_id as string;
    const draftArgs = {
      ...investigationArgs,
      action_type: 'adjust_ad_budget',
      unit: 'currency_per_day',
      currency: 'USD',
      reason: 'Investigated advertising loss',
      evidence_trace_ids: [firstTrace],
      current_value: 37.5,
      proposed_value: 3,
    };
    expect((await draft.handler(draftArgs, {})).isError).not.toBe(true);

    promptPlanHash = 'plan-v2';
    const stale = await draft.handler(draftArgs, {});
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(/PromptPlan/);

    const fresh = await investigate.handler(investigationArgs, {});
    const freshTrace = JSON.parse(fresh.content[0].text).trace
      .trace_id as string;
    const mixed = await draft.handler(
      { ...draftArgs, evidence_trace_ids: [firstTrace, freshTrace] },
      {},
    );
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0].text).toMatch(/PromptPlan/);
    expect(
      (
        await draft.handler(
          { ...draftArgs, evidence_trace_ids: [freshTrace] },
          {},
        )
      ).isError,
    ).not.toBe(true);
  });

  test('uses the current warm-runner turn and session in each trace', async () => {
    let turnId = 'turn-one';
    let sessionId = 'session-one';
    let promptPlanHash = 'plan-one';
    const tool = createEcommerceTools({
      dataDir,
      getInputTurnId: () => turnId,
      getSessionId: () => sessionId,
      getPromptPlanHash: () => promptPlanHash,
    }).find((candidate) => candidate.name === 'ecommerce_dataset_status')!;
    await tool.handler({}, {});
    turnId = 'turn-two';
    sessionId = 'session-two';
    promptPlanHash = 'plan-two';
    const result = await tool.handler({}, {});
    const body = JSON.parse(result.content[0].text) as {
      trace: { trace_id: string };
    };
    const traces = fs
      .readFileSync(path.join(dataDir, '.traces', 'tool-traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      traces.find((trace) => trace.trace_id === body.trace.trace_id),
    ).toMatchObject({
      input_turn_id: 'turn-two',
      session_id: 'session-two',
      prompt_plan_hash: 'plan-two',
    });
  });

  test('registers tools only when the workspace contains ecommerce data', () => {
    const baseContext = {
      chatJid: 'web:ecommerce-test',
      groupFolder: 'ecommerce-test',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      currentInputTurnId: 'turn-ecommerce-1',
      currentSessionId: 'session-ecommerce-1',
      workspaceIpc: path.join(tempRoot, 'ipc'),
    };
    const withDataset = createMcpTools({
      ...baseContext,
      workspaceGroup: tempRoot,
    }).map((tool) => tool.name);
    const withoutDataset = createMcpTools({
      ...baseContext,
      workspaceGroup: path.join(tempRoot, 'empty-workspace'),
    }).map((tool) => tool.name);

    expect(withDataset).toEqual(
      expect.arrayContaining([
        'ecommerce_monitor',
        'ecommerce_compare_ad_budget_options',
        'ecommerce_review_windows',
        'ecommerce_dataset_status',
        'ecommerce_query_sales',
        'ecommerce_query_inventory',
        'ecommerce_query_ads',
        'ecommerce_calculate_profit',
        'ecommerce_investigate_sku',
        'ecommerce_draft_action',
        'ecommerce_action_status',
      ]),
    );
    expect(withoutDataset).not.toContain('ecommerce_investigate_sku');
    expect(withDataset.some((name) => /approve|execute/.test(name))).toBe(
      false,
    );
  });

  test('returns structured evidence and persists an auditable trace', async () => {
    const tools = createEcommerceTools({
      dataDir,
      inputTurnId: 'turn-ecommerce-2',
      sessionId: 'session-ecommerce-2',
    });
    const tool = tools.find(
      (candidate) => candidate.name === 'ecommerce_investigate_sku',
    );
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        reference_time: '2026-09-08T12:00:00Z',
      },
      {},
    );
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content[0].text) as {
      data: { status: string };
      trace: { trace_id: string; persisted: boolean };
    };
    expect(body.data.status).toBe('ready_for_recommendation');
    expect(body.trace.persisted).toBe(true);

    const traceFile = path.join(dataDir, '.traces', 'tool-traces.jsonl');
    const traces = fs
      .readFileSync(traceFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traces).toContainEqual(
      expect.objectContaining({
        trace_id: body.trace.trace_id,
        tool: 'ecommerce_investigate_sku',
        input_turn_id: 'turn-ecommerce-2',
        session_id: 'session-ecommerce-2',
      }),
    );

    const draftTool = tools.find(
      (candidate) => candidate.name === 'ecommerce_draft_action',
    );
    expect(draftTool).toBeDefined();
    const draftResult = await draftTool!.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        action_type: 'adjust_ad_budget',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Negative margin and low advertising return',
        evidence_trace_ids: [body.trace.trace_id],
        current_value: 37.5,
        proposed_value: 3,
      },
      {},
    );
    expect(draftResult.isError).not.toBe(true);
    const draftBody = JSON.parse(draftResult.content[0].text) as {
      data: { action_id: string; revision: number };
    };
    expect(draftBody.data.revision).toBe(1);
    expect(readActionDraft(dataDir, draftBody.data.action_id)).toMatchObject({
      action_id: draftBody.data.action_id,
      status: 'approval_required',
      executable: false,
      revision: 1,
    });

    const mismatchedWindow = await draftTool!.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        action_type: 'adjust_ad_budget',
        start_date: '2026-09-02',
        end_date: '2026-09-07',
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Wrong evidence window',
        evidence_trace_ids: [body.trace.trace_id],
        current_value: 37.5,
        proposed_value: 3,
      },
      {},
    );
    expect(mismatchedWindow.isError).toBe(true);
    expect(mismatchedWindow.content[0].text).toMatch(
      /Evidence trace does not match/,
    );

    fs.appendFileSync(path.join(dataDir, 'sales.csv'), '\n');
    const changedDataset = await draftTool!.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        action_type: 'adjust_ad_budget',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Stale evidence',
        evidence_trace_ids: [body.trace.trace_id],
        current_value: 37.5,
        proposed_value: 3,
      },
      {},
    );
    expect(changedDataset.isError).toBe(true);
    expect(changedDataset.content[0].text).toMatch(/current dataset/);
    copyDataset(dataDir);

    const statusTool = createEcommerceTools({ dataDir }).find(
      (candidate) => candidate.name === 'ecommerce_action_status',
    );
    const statusResult = await statusTool!.handler(
      { action_id: draftBody.data.action_id },
      {},
    );
    expect(statusResult.isError).not.toBe(true);

    const unsafeResult = await draftTool!.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        action_type: 'adjust_ad_budget',
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Unsafe budget should be rejected',
        evidence_trace_ids: [body.trace.trace_id],
        current_value: 37.5,
        proposed_value: 10,
      },
      {},
    );
    expect(unsafeResult.isError).toBe(true);
    expect(unsafeResult.content[0].text).toMatch(/maximum daily budget 3.04/);

    const unknownTraceResult = await draftTool!.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        action_type: 'adjust_ad_budget',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Unsupported evidence reference',
        evidence_trace_ids: ['trace-does-not-exist'],
        current_value: 37.5,
        proposed_value: 3,
      },
      {},
    );
    expect(unknownTraceResult.isError).toBe(true);
    expect(unknownTraceResult.content[0].text).toMatch(
      /Unknown evidence_trace_ids/,
    );
  });
});
