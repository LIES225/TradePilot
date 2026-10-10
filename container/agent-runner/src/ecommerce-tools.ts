import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  defineMcpTool,
  type McpToolDefinition,
  type McpToolResult,
} from './mcp-tool-types.js';

const REQUIRED_DATA_FILES = [
  'products.csv',
  'sales.csv',
  'inventory.csv',
  'ads.csv',
  'promotions.csv',
  'costs.csv',
] as const;

export const ECOMMERCE_SOP = `When ecommerce-data is present, follow this decision sequence:
1. Monitor SKU signals, then investigate one explicit sku_id, site, and date window. Never infer a missing daily row as zero activity.
2. Read sales and inventory, then advertising and promotions, then profit and currency constraints. Stop and request missing or stale evidence before recommending an action.
3. Compare options with stated assumptions. CTR, CPC, promotions, and advertising attribution are observations, not proof of causality.
4. Draft high-risk changes only with a matching, complete investigation trace. A draft is not approval. Never claim a price, budget, inventory, or listing change was executed.
5. After a human-operated change outside these tools, investigate a new time window before claiming an outcome.`;

const skuIdSchema = z.string().trim().min(1).brand<'SkuId'>();
const siteSchema = z.string().trim().min(1).max(32);
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/));
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    },
    {
      message: 'must be a valid YYYY-MM-DD date',
    },
  );
const dateTimeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(
    (value) =>
      dateSchema.safeParse(value.slice(0, 10)).success &&
      Number.isFinite(Date.parse(value)),
    {
      message: 'must be a valid ISO 8601 timestamp',
    },
  );
const finiteNumberSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  z.number().finite(),
);
const nonNegativeNumberSchema = finiteNumberSchema.pipe(z.number().min(0));
const nonNegativeIntegerSchema = finiteNumberSchema.pipe(
  z.number().int().min(0),
);

const productSchema = z.object({
  sku_id: skuIdSchema,
  site: siteSchema,
  title: z.string().trim().min(1),
  status: z.enum(['active', 'inactive']),
  bundle_components: z.string().trim().optional(),
  list_price: nonNegativeNumberSchema.optional(),
  price_currency: currencySchema.optional(),
});
const saleSchema = z.object({
  date: dateSchema,
  sku_id: skuIdSchema,
  site: siteSchema,
  units: nonNegativeIntegerSchema,
  revenue: nonNegativeNumberSchema,
  currency: currencySchema,
});
const inventorySchema = z.object({
  captured_at: dateTimeSchema,
  sku_id: skuIdSchema,
  site: siteSchema,
  available: nonNegativeIntegerSchema,
  inbound: nonNegativeIntegerSchema,
  reserved: nonNegativeIntegerSchema,
});
const adSchema = z.object({
  date: dateSchema,
  sku_id: skuIdSchema,
  site: siteSchema,
  daily_budget: nonNegativeNumberSchema,
  spend: nonNegativeNumberSchema,
  impressions: nonNegativeIntegerSchema,
  clicks: nonNegativeIntegerSchema,
  attributed_sales: nonNegativeNumberSchema,
  currency: currencySchema,
});
const promotionSchema = z.object({
  sku_id: skuIdSchema,
  site: siteSchema,
  start_date: dateSchema,
  end_date: dateSchema,
  discount_type: z.enum(['percentage', 'fixed']),
  discount_value: nonNegativeNumberSchema,
  currency: currencySchema.optional(),
});
const costSchema = z.object({
  sku_id: skuIdSchema,
  site: siteSchema,
  currency: currencySchema,
  unit_cost: nonNegativeNumberSchema,
  fulfillment_cost: nonNegativeNumberSchema,
  platform_fee_rate: finiteNumberSchema.pipe(z.number().min(0).max(1)),
  cost_basis: z.enum(['sku_unit', 'bundle_total']).optional(),
});

type Product = z.infer<typeof productSchema>;
type Sale = z.infer<typeof saleSchema>;
type Inventory = z.infer<typeof inventorySchema>;
type Ad = z.infer<typeof adSchema>;
type Promotion = z.infer<typeof promotionSchema>;
type Cost = z.infer<typeof costSchema>;

interface EcommerceDataset {
  products: Product[];
  sales: Sale[];
  inventory: Inventory[];
  ads: Ad[];
  promotions: Promotion[];
  costs: Cost[];
}

interface QueryWindow {
  skuId: string;
  startDate: string;
  endDate: string;
  site?: string;
}

interface EvidenceScope {
  skuId: string;
  site: string;
  startDate: string;
  endDate: string;
  sessionId?: string | null;
  promptPlanHash?: string | null;
}

interface ActionDraftInput {
  skuId: string;
  site: string;
  actionType: EcommerceActionType;
  unit: EcommerceActionUnit;
  currency?: string;
  reason: string;
  evidenceTraceIds: string[];
  currentValue?: number;
  proposedValue?: number;
}

export interface EcommerceToolOptions {
  dataDir: string;
  getPromptPlanHash?: () => string | null | undefined;
  inputTurnId?: string | null;
  sessionId?: string | null;
  getInputTurnId?: () => string | null | undefined;
  getSessionId?: () => string | null | undefined;
}

export class EcommerceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcommerceDataError';
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new EcommerceDataError('CSV contains an unclosed quote');
  row.push(field.replace(/\r$/, ''));
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function readCsv<T>(
  dataDir: string,
  filename: string,
  schema: z.ZodType<T>,
): T[] {
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new EcommerceDataError(`Missing ecommerce dataset file: ${filename}`);
  }
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const headers = rows.shift()?.map((value) => value.trim()) ?? [];
  if (!headers.length || new Set(headers).size !== headers.length) {
    throw new EcommerceDataError(
      `${filename} has missing or duplicate headers`,
    );
  }
  return rows.map((values, index) => {
    if (values.length !== headers.length) {
      throw new EcommerceDataError(
        `${filename} row ${index + 2}: expected ${headers.length} columns, got ${values.length}`,
      );
    }
    const record = Object.fromEntries(
      headers.map((header, column) => [header, values[column] ?? '']),
    );
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      throw new EcommerceDataError(
        `${filename} row ${index + 2}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  });
}

export function hasEcommerceDataset(dataDir: string): boolean {
  return (
    fs.existsSync(dataDir) &&
    fs.statSync(dataDir).isDirectory() &&
    REQUIRED_DATA_FILES.some((filename) =>
      fs.existsSync(path.join(dataDir, filename)),
    )
  );
}

function requireUniqueRows<T>(
  rows: T[],
  filename: string,
  keyOf: (row: T) => readonly (string | number)[],
): T[] {
  const firstRows = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = JSON.stringify(keyOf(row));
    const firstRow = firstRows.get(key);
    if (firstRow !== undefined) {
      throw new EcommerceDataError(
        `${filename} row ${index + 2}: duplicate business key (first at row ${firstRow})`,
      );
    }
    firstRows.set(key, index + 2);
  });
  return rows;
}

export function loadEcommerceDataset(dataDir: string): EcommerceDataset {
  return {
    products: requireUniqueRows(
      readCsv(dataDir, 'products.csv', productSchema),
      'products.csv',
      (row) => [row.site, row.sku_id],
    ),
    sales: requireUniqueRows(
      readCsv(dataDir, 'sales.csv', saleSchema),
      'sales.csv',
      (row) => [row.site, row.sku_id, row.date],
    ),
    inventory: requireUniqueRows(
      readCsv(dataDir, 'inventory.csv', inventorySchema),
      'inventory.csv',
      (row) => [row.site, row.sku_id, row.captured_at],
    ),
    ads: requireUniqueRows(
      readCsv(dataDir, 'ads.csv', adSchema),
      'ads.csv',
      (row) => [row.site, row.sku_id, row.date],
    ),
    promotions: requireUniqueRows(
      readCsv(dataDir, 'promotions.csv', promotionSchema),
      'promotions.csv',
      (row) => [
        row.site,
        row.sku_id,
        row.start_date,
        row.end_date,
        row.discount_type,
        row.discount_value,
      ],
    ),
    costs: requireUniqueRows(
      readCsv(dataDir, 'costs.csv', costSchema),
      'costs.csv',
      (row) => [row.site, row.sku_id],
    ),
  };
}

function validateWindow(window: QueryWindow): void {
  if (!dateSchema.safeParse(window.startDate).success) {
    throw new EcommerceDataError('start_date must be a valid YYYY-MM-DD date');
  }
  if (!dateSchema.safeParse(window.endDate).success) {
    throw new EcommerceDataError('end_date must be a valid YYYY-MM-DD date');
  }
  if (window.startDate > window.endDate) {
    throw new EcommerceDataError('start_date must not be later than end_date');
  }
  const days =
    (Date.parse(`${window.endDate}T00:00:00Z`) -
      Date.parse(`${window.startDate}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (days > 366) {
    throw new EcommerceDataError('date window must not exceed 366 days');
  }
}

function requireProduct(
  dataset: EcommerceDataset,
  skuId: string,
  site?: string,
): Product {
  const matches = dataset.products.filter(
    (item) => item.sku_id === skuId && (!site || item.site === site),
  );
  if (!site && new Set(matches.map((item) => item.site)).size > 1) {
    throw new EcommerceDataError(
      `sku_id ${skuId} exists at multiple sites; site is required`,
    );
  }
  const product = matches[0];
  if (!product) {
    throw new EcommerceDataError(
      site
        ? `Unknown sku_id ${skuId} for site ${site}`
        : `Unknown sku_id ${skuId}`,
    );
  }
  return product;
}

function distinctCurrency(values: Array<{ currency: string }>): string | null {
  const currencies = [...new Set(values.map((value) => value.currency))];
  if (currencies.length > 1) {
    throw new EcommerceDataError(
      `Currency mismatch in evidence: ${currencies.join(', ')}`,
    );
  }
  return currencies[0] ?? null;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function dateCoverage(rows: Array<{ date: string }>, window: QueryWindow) {
  const expectedDates = enumerateDates(window.startDate, window.endDate);
  const observedDates = [...new Set(rows.map((row) => row.date))].sort();
  const observedSet = new Set(observedDates);
  const missingDates = expectedDates.filter((date) => !observedSet.has(date));
  return {
    expected_date_count: expectedDates.length,
    observed_date_count: observedDates.length,
    coverage_ratio:
      expectedDates.length === 0
        ? 0
        : observedDates.length / expectedDates.length,
    observed_dates: observedDates,
    missing_dates: missingDates,
    complete: missingDates.length === 0,
  };
}

export function querySales(dataset: EcommerceDataset, window: QueryWindow) {
  validateWindow(window);
  const product = requireProduct(dataset, window.skuId, window.site);
  const rows = dataset.sales.filter(
    (item) =>
      item.sku_id === window.skuId &&
      item.site === product.site &&
      item.date >= window.startDate &&
      item.date <= window.endDate,
  );
  const units = rows.reduce((sum, item) => sum + item.units, 0);
  const revenue = rows.reduce((sum, item) => sum + item.revenue, 0);
  return {
    sku_id: product.sku_id,
    site: product.site,
    start_date: window.startDate,
    end_date: window.endDate,
    units,
    revenue,
    currency: distinctCurrency(rows),
    row_count: rows.length,
    date_coverage: dateCoverage(rows, window),
    source: 'sales.csv',
  };
}

export function queryInventory(
  dataset: EcommerceDataset,
  skuId: string,
  site?: string,
) {
  const product = requireProduct(dataset, skuId, site);
  const latest = dataset.inventory
    .filter((item) => item.sku_id === skuId && item.site === product.site)
    .sort((left, right) =>
      right.captured_at.localeCompare(left.captured_at),
    )[0];
  if (!latest) throw new EcommerceDataError(`No inventory found for ${skuId}`);
  return {
    sku_id: product.sku_id,
    site: product.site,
    captured_at: latest.captured_at,
    available: latest.available,
    inbound: latest.inbound,
    reserved: latest.reserved,
    source: 'inventory.csv',
  };
}

export function queryAds(dataset: EcommerceDataset, window: QueryWindow) {
  validateWindow(window);
  const product = requireProduct(dataset, window.skuId, window.site);
  const rows = dataset.ads.filter(
    (item) =>
      item.sku_id === window.skuId &&
      item.site === product.site &&
      item.date >= window.startDate &&
      item.date <= window.endDate,
  );
  const spend = rows.reduce((sum, item) => sum + item.spend, 0);
  const impressions = rows.reduce((sum, item) => sum + item.impressions, 0);
  const clicks = rows.reduce((sum, item) => sum + item.clicks, 0);
  const attributedSales = rows.reduce(
    (sum, item) => sum + item.attributed_sales,
    0,
  );
  const latestBudget = [...rows].sort((left, right) =>
    right.date.localeCompare(left.date),
  )[0];
  return {
    sku_id: product.sku_id,
    site: product.site,
    start_date: window.startDate,
    end_date: window.endDate,
    spend,
    current_daily_budget: latestBudget?.daily_budget ?? null,
    budget_captured_on: latestBudget?.date ?? null,
    impressions,
    clicks,
    attributed_sales: attributedSales,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    roas: spend > 0 ? attributedSales / spend : null,
    currency: distinctCurrency(rows),
    row_count: rows.length,
    date_coverage: dateCoverage(rows, window),
    source: 'ads.csv',
  };
}

export function calculateProfit(
  dataset: EcommerceDataset,
  window: QueryWindow,
) {
  const sales = querySales(dataset, window);
  const ads = queryAds(dataset, window);
  const cost = dataset.costs.find(
    (item) => item.sku_id === window.skuId && item.site === sales.site,
  );
  if (!cost) throw new EcommerceDataError(`No cost found for ${window.skuId}`);
  const product = requireProduct(dataset, window.skuId, sales.site);
  if (product.bundle_components && cost.cost_basis !== 'bundle_total') {
    throw new EcommerceDataError(
      `Bundle ${window.skuId} requires explicit bundle_total cost_basis`,
    );
  }
  const evidenceCurrencies = [
    sales.currency,
    ads.currency,
    cost.currency,
  ].filter((value): value is string => Boolean(value));
  if (new Set(evidenceCurrencies).size > 1) {
    throw new EcommerceDataError(
      `Currency mismatch in profit evidence: ${evidenceCurrencies.join(', ')}`,
    );
  }
  const productCost = cost.unit_cost * sales.units;
  const fulfillmentCost = cost.fulfillment_cost * sales.units;
  const platformFee = sales.revenue * cost.platform_fee_rate;
  const profit =
    sales.revenue - productCost - fulfillmentCost - platformFee - ads.spend;
  return {
    sku_id: sales.sku_id,
    site: sales.site,
    start_date: window.startDate,
    end_date: window.endDate,
    revenue: sales.revenue,
    product_cost: productCost,
    fulfillment_cost: fulfillmentCost,
    platform_fee: platformFee,
    ad_spend: ads.spend,
    profit,
    margin: sales.revenue > 0 ? profit / sales.revenue : null,
    currency: evidenceCurrencies[0] ?? cost.currency,
    sources: ['sales.csv', 'ads.csv', 'costs.csv'],
  };
}

export function investigateSku(
  dataset: EcommerceDataset,
  window: QueryWindow,
  referenceTime: string,
) {
  if (!dateTimeSchema.safeParse(referenceTime).success) {
    throw new EcommerceDataError(
      'reference_time must be a valid ISO 8601 timestamp',
    );
  }
  const product = requireProduct(dataset, window.skuId, window.site);
  const sales = querySales(dataset, window);
  const inventory = queryInventory(dataset, window.skuId, window.site);
  const ads = queryAds(dataset, window);
  const profit = calculateProfit(dataset, window);
  const promotions = dataset.promotions.filter(
    (item) =>
      item.sku_id === window.skuId &&
      item.site === product.site &&
      item.start_date <= window.endDate &&
      item.end_date >= window.startDate,
  );
  const warnings: string[] = [];
  const findings: string[] = [];
  const inventoryAgeHours =
    (Date.parse(referenceTime) - Date.parse(inventory.captured_at)) / 3_600_000;

  if (inventoryAgeHours > 24) warnings.push('inventory_data_is_stale');
  if (inventoryAgeHours < 0) warnings.push('inventory_timestamp_is_in_future');
  if (sales.row_count === 0) warnings.push('sales_evidence_missing');
  if (ads.row_count === 0) warnings.push('ads_evidence_missing');
  if (!sales.date_coverage.complete)
    warnings.push('sales_date_coverage_incomplete');
  if (!ads.date_coverage.complete)
    warnings.push('ads_date_coverage_incomplete');
  if (profit.margin !== null && profit.margin < 0)
    findings.push('negative_margin');
  if (ads.roas !== null && ads.roas < 1.5) findings.push('low_ad_roas');
  if (sales.units > 0) {
    const days = sales.date_coverage.expected_date_count;
    const dailyUnits = sales.units / Math.max(days, 1);
    if (inventory.available < dailyUnits * 7)
      findings.push('inventory_below_seven_day_run_rate');
  }
  if (
    promotions.some((left, index) =>
      promotions
        .slice(index + 1)
        .some(
          (right) =>
            left.start_date <= right.end_date &&
            right.start_date <= left.end_date,
        ),
    )
  )
    findings.push('overlapping_promotions');

  const evidenceComplete = warnings.length === 0;
  return {
    sku_id: product.sku_id,
    site: product.site,
    start_date: window.startDate,
    end_date: window.endDate,
    status: evidenceComplete
      ? 'ready_for_recommendation'
      : 'needs_more_evidence',
    findings,
    warnings,
    missing_material: [
      ...(sales.date_coverage.complete
        ? []
        : sales.date_coverage.missing_dates.map(
            (date) => `sales.csv:${product.site}:${product.sku_id}:${date}`,
          )),
      ...(ads.date_coverage.complete
        ? []
        : ads.date_coverage.missing_dates.map(
            (date) => `ads.csv:${product.site}:${product.sku_id}:${date}`,
          )),
    ],
    claim_constraints: [
      'Do not classify CTR or CPC as normal or abnormal without an explicit benchmark.',
      'Do not claim that a promotion caused a metric change without comparison evidence.',
      'Treat explicit zero-value daily rows as observed zero activity; a missing date is missing evidence.',
    ],
    sales,
    inventory,
    ads,
    profit,
    active_promotions: promotions,
    next_step: evidenceComplete
      ? 'Compare options and create an approval-required action draft.'
      : 'Refresh or complete the missing evidence before recommending an action.',
  };
}

export function monitorEcommerce(
  dataset: EcommerceDataset,
  window: Omit<QueryWindow, 'skuId'>,
  referenceTime: string,
) {
  validateWindow({ ...window, skuId: '' });
  const products = dataset.products.filter(
    (product) => !window.site || product.site === window.site,
  );
  return {
    start_date: window.startDate,
    end_date: window.endDate,
    reference_time: referenceTime,
    alerts: products
      .map((product) => {
        try {
          const investigation = investigateSku(
            dataset,
            {
              ...window,
              skuId: product.sku_id,
              site: product.site,
            },
            referenceTime,
          );
          return {
            sku_id: product.sku_id,
            site: product.site,
            status: investigation.status,
            findings: investigation.findings,
            warnings: investigation.warnings,
            missing_material: investigation.missing_material,
          };
        } catch (error) {
          return {
            sku_id: product.sku_id,
            site: product.site,
            status: 'needs_more_evidence' as const,
            findings: [],
            warnings: [error instanceof Error ? error.message : String(error)],
            missing_material: [],
          };
        }
      })
      .filter((item) => item.findings.length > 0 || item.warnings.length > 0),
  };
}

export function compareAdBudgetOptions(
  dataset: EcommerceDataset,
  window: QueryWindow,
  referenceTime: string,
) {
  const investigation = investigateSku(dataset, window, referenceTime);
  if (investigation.status !== 'ready_for_recommendation') {
    return {
      status: 'needs_more_evidence' as const,
      sku_id: investigation.sku_id,
      site: investigation.site,
      warnings: investigation.warnings,
      options: [],
    };
  }
  const { ads, profit, sales } = investigation;
  if (
    ads.current_daily_budget === null ||
    ads.currency === null ||
    sales.revenue <= 0
  ) {
    return {
      status: 'needs_more_evidence' as const,
      sku_id: investigation.sku_id,
      site: investigation.site,
      warnings: ['budget_or_revenue_evidence_missing'],
      options: [],
    };
  }
  const preAdContribution = profit.profit + ads.spend;
  const preAdMarginRate = preAdContribution / sales.revenue;
  if (preAdMarginRate < 0) {
    return {
      status: 'needs_more_evidence' as const,
      sku_id: investigation.sku_id,
      site: investigation.site,
      warnings: ['negative_pre_ad_margin'],
      options: [],
    };
  }
  const maximum =
    Math.min(ads.attributed_sales * preAdMarginRate, preAdContribution) /
    sales.date_coverage.expected_date_count;
  const reducedBudget = Math.min(
    ads.current_daily_budget,
    Math.floor(Math.max(0, maximum) * 100) / 100,
  );
  const options = [
    { option: 'hold', daily_budget: ads.current_daily_budget },
    { option: 'reduce_to_policy_limit', daily_budget: reducedBudget },
    { option: 'pause_ad_spend', daily_budget: 0 },
  ].map((candidate) => {
    const estimatedSpend =
      ads.current_daily_budget > 0
        ? (ads.spend * candidate.daily_budget) / ads.current_daily_budget
        : 0;
    return {
      ...candidate,
      policy_status:
        candidate.daily_budget <= maximum + 1e-6
          ? 'within_limit'
          : 'above_limit',
      estimated_profit_if_sales_unchanged: preAdContribution - estimatedSpend,
    };
  });
  return {
    status: 'ready_for_comparison' as const,
    sku_id: investigation.sku_id,
    site: investigation.site,
    start_date: window.startDate,
    end_date: window.endDate,
    currency: profit.currency,
    current_daily_budget: ads.current_daily_budget,
    policy_max_daily_budget: maximum,
    options,
    assumption:
      'Illustrative scenarios, not forecasts: sales, attributed revenue, and unit costs are held constant; actual demand and advertising attribution may change.',
    next_step:
      'A human reviewer must choose an option before any external action.',
  };
}

export function reviewEcommerceWindows(
  dataset: EcommerceDataset,
  before: QueryWindow,
  after: QueryWindow,
) {
  validateWindow(before);
  validateWindow(after);
  if (before.skuId !== after.skuId || before.site !== after.site) {
    throw new EcommerceDataError(
      'Review windows must use the same sku_id and site',
    );
  }
  if (before.endDate >= after.startDate) {
    throw new EcommerceDataError('Review windows must not overlap');
  }
  const beforeDays = enumerateDates(before.startDate, before.endDate).length;
  const afterDays = enumerateDates(after.startDate, after.endDate).length;
  if (beforeDays !== afterDays) {
    throw new EcommerceDataError(
      'Review windows must have the same number of days',
    );
  }
  const beforeSales = querySales(dataset, before);
  const afterSales = querySales(dataset, after);
  const beforeAds = queryAds(dataset, before);
  const afterAds = queryAds(dataset, after);
  const beforeProfit = calculateProfit(dataset, before);
  const afterProfit = calculateProfit(dataset, after);
  if (
    beforeSales.site !== afterSales.site ||
    beforeProfit.currency !== afterProfit.currency
  ) {
    throw new EcommerceDataError('Review evidence site or currency mismatch');
  }
  const complete =
    beforeSales.date_coverage.complete &&
    afterSales.date_coverage.complete &&
    beforeAds.date_coverage.complete &&
    afterAds.date_coverage.complete;
  return {
    status: complete ? ('observed' as const) : ('needs_more_evidence' as const),
    comparison_days: beforeDays,
    sku_id: beforeSales.sku_id,
    site: beforeSales.site,
    currency: beforeProfit.currency,
    before: {
      start_date: before.startDate,
      end_date: before.endDate,
      revenue: beforeSales.revenue,
      units: beforeSales.units,
      ad_spend: beforeAds.spend,
      profit: beforeProfit.profit,
    },
    after: {
      start_date: after.startDate,
      end_date: after.endDate,
      revenue: afterSales.revenue,
      units: afterSales.units,
      ad_spend: afterAds.spend,
      profit: afterProfit.profit,
    },
    delta: {
      revenue: afterSales.revenue - beforeSales.revenue,
      units: afterSales.units - beforeSales.units,
      ad_spend: afterAds.spend - beforeAds.spend,
      profit: afterProfit.profit - beforeProfit.profit,
    },
    missing_material: [
      ...beforeSales.date_coverage.missing_dates.map(
        (date) => `sales.csv:before:${date}`,
      ),
      ...afterSales.date_coverage.missing_dates.map(
        (date) => `sales.csv:after:${date}`,
      ),
      ...beforeAds.date_coverage.missing_dates.map(
        (date) => `ads.csv:before:${date}`,
      ),
      ...afterAds.date_coverage.missing_dates.map(
        (date) => `ads.csv:after:${date}`,
      ),
    ],
    limitation:
      'Observed differences do not establish that a draft was approved, executed, or caused the outcome; there is no external execution connector.',
  };
}

const actionTypes = [
  'adjust_price',
  'adjust_ad_budget',
  'replenish_inventory',
  'pause_listing',
] as const;

export type EcommerceActionType = (typeof actionTypes)[number];

const actionUnits = [
  'currency_per_day',
  'currency_per_unit',
  'units',
  'listing_state',
] as const;

export type EcommerceActionUnit = (typeof actionUnits)[number];

export function parseEcommerceActionType(value: string): EcommerceActionType {
  const parsed = z.enum(actionTypes).safeParse(value);
  if (!parsed.success) {
    throw new EcommerceDataError(
      `Invalid action_type ${value}. Expected one of: ${actionTypes.join(', ')}`,
    );
  }
  return parsed.data;
}

export function parseEcommerceActionUnit(value: string): EcommerceActionUnit {
  const parsed = z.enum(actionUnits).safeParse(value);
  if (!parsed.success) {
    throw new EcommerceDataError(
      `Invalid unit ${value}. Expected one of: ${actionUnits.join(', ')}`,
    );
  }
  return parsed.data;
}

export function draftAction(input: ActionDraftInput) {
  if (!input.skuId.trim()) {
    throw new EcommerceDataError('sku_id is required');
  }
  if (!siteSchema.safeParse(input.site).success) {
    throw new EcommerceDataError('site is required');
  }
  if (!input.reason.trim()) {
    throw new EcommerceDataError('reason is required');
  }
  if (
    input.evidenceTraceIds.length === 0 ||
    input.evidenceTraceIds.some((traceId) => !traceId.trim())
  ) {
    throw new EcommerceDataError(
      'at least one non-empty evidence_trace_id is required',
    );
  }
  const expectedUnit: Record<EcommerceActionType, EcommerceActionUnit> = {
    adjust_price: 'currency_per_unit',
    adjust_ad_budget: 'currency_per_day',
    replenish_inventory: 'units',
    pause_listing: 'listing_state',
  };
  if (input.unit !== expectedUnit[input.actionType]) {
    throw new EcommerceDataError(
      `${input.actionType} requires unit ${expectedUnit[input.actionType]}`,
    );
  }

  const numericAction = input.actionType !== 'pause_listing';
  if (numericAction) {
    for (const [name, value] of [
      ['current_value', input.currentValue],
      ['proposed_value', input.proposedValue],
    ] as const) {
      if (value === undefined || !Number.isFinite(value) || value < 0) {
        throw new EcommerceDataError(
          `${name} must be a non-negative finite number for ${input.actionType}`,
        );
      }
    }
  } else if (
    input.currentValue !== undefined ||
    input.proposedValue !== undefined
  ) {
    throw new EcommerceDataError(
      'pause_listing must not contain numeric current_value or proposed_value',
    );
  }

  if (
    input.actionType === 'replenish_inventory' &&
    (!Number.isInteger(input.currentValue) ||
      !Number.isInteger(input.proposedValue))
  ) {
    throw new EcommerceDataError('replenish_inventory values must be integers');
  }

  const currencyAction =
    input.actionType === 'adjust_price' ||
    input.actionType === 'adjust_ad_budget';
  const parsedCurrency = input.currency
    ? currencySchema.safeParse(input.currency)
    : null;
  if (currencyAction && (!parsedCurrency || !parsedCurrency.success)) {
    throw new EcommerceDataError(
      `${input.actionType} requires a three-letter currency`,
    );
  }
  if (!currencyAction && input.currency !== undefined) {
    throw new EcommerceDataError(
      `${input.actionType} must not contain currency`,
    );
  }
  return {
    action_id: `action-${crypto.randomUUID()}`,
    sku_id: input.skuId,
    site: input.site,
    action_type: input.actionType,
    current_value: input.currentValue ?? null,
    proposed_value: input.proposedValue ?? null,
    unit: input.unit,
    currency:
      parsedCurrency && parsedCurrency.success ? parsedCurrency.data : null,
    reason: input.reason,
    evidence_trace_ids: input.evidenceTraceIds,
    status: 'approval_required' as const,
    executable: false,
    boundary:
      'This draft cannot change price, budget, inventory, or listing state.',
  };
}

export function draftGovernedAction(
  dataset: EcommerceDataset,
  input: ActionDraftInput,
  window?: QueryWindow,
  referenceTime = new Date().toISOString(),
) {
  const draft = draftAction(input);
  if (!window) {
    throw new EcommerceDataError(
      `${input.actionType} requires start_date and end_date for policy evaluation`,
    );
  }
  if (
    window.skuId !== input.skuId ||
    (window.site !== undefined && window.site !== input.site)
  ) {
    throw new EcommerceDataError(
      'Policy window SKU and site must match the action draft',
    );
  }
  const scopedDraft = {
    ...draft,
    evidence_window: {
      start_date: window.startDate,
      end_date: window.endDate,
    },
  };

  if (input.actionType === 'adjust_price') {
    const product = requireProduct(dataset, input.skuId, input.site);
    const cost = dataset.costs.find(
      (item) => item.sku_id === input.skuId && item.site === input.site,
    );
    if (product.status !== 'active' || !cost) {
      throw new EcommerceDataError(
        'Price policy requires an active listing and cost evidence',
      );
    }
    if (product.list_price === undefined || !product.price_currency) {
      throw new EcommerceDataError(
        'Price policy requires list_price and price_currency in products.csv',
      );
    }
    if (product.bundle_components && cost.cost_basis !== 'bundle_total') {
      throw new EcommerceDataError(
        'Price policy requires explicit bundle_total cost_basis',
      );
    }
    const sales = querySales(dataset, window);
    const ads = queryAds(dataset, window);
    const profit = calculateProfit(dataset, window);
    if (!sales.date_coverage.complete || !ads.date_coverage.complete) {
      throw new EcommerceDataError(
        'Price policy requires complete daily evidence',
      );
    }
    if (
      draft.currency !== product.price_currency ||
      draft.currency !== profit.currency
    ) {
      throw new EcommerceDataError(
        'Price policy currency must match listing and cost evidence',
      );
    }
    if (
      input.currentValue === undefined ||
      Math.abs(input.currentValue - product.list_price) > 1e-6
    ) {
      throw new EcommerceDataError(
        `current_value must match the listed price ${product.list_price}`,
      );
    }
    const promotions = dataset.promotions.filter(
      (item) =>
        item.sku_id === input.skuId &&
        item.site === input.site &&
        item.start_date <= window.endDate &&
        item.end_date >= window.startDate,
    );
    if (
      promotions.some(
        (item) =>
          item.discount_type === 'fixed' && item.currency !== draft.currency,
      )
    ) {
      throw new EcommerceDataError(
        'Price policy requires a matching currency for each fixed promotion',
      );
    }
    if (
      promotions.some(
        (item) =>
          item.discount_type === 'percentage' && item.discount_value > 100,
      )
    ) {
      throw new EcommerceDataError(
        'Price policy rejects percentage discounts above 100',
      );
    }
    const promotionalPrices = enumerateDates(
      window.startDate,
      window.endDate,
    ).map((date) => {
      const active = promotions.filter(
        (item) => item.start_date <= date && item.end_date >= date,
      );
      const factor = active
        .filter((item) => item.discount_type === 'percentage')
        .reduce((value, item) => value * (1 - item.discount_value / 100), 1);
      const fixed = active
        .filter((item) => item.discount_type === 'fixed')
        .reduce((value, item) => value + item.discount_value, 0);
      return Math.max(0, (input.proposedValue ?? 0) * factor - fixed);
    });
    const minimumPromotionalPrice = Math.min(...promotionalPrices);
    const breakEvenFloor =
      (cost.unit_cost + cost.fulfillment_cost) / (1 - cost.platform_fee_rate);
    if (
      !Number.isFinite(breakEvenFloor) ||
      minimumPromotionalPrice + 1e-6 < breakEvenFloor
    ) {
      throw new EcommerceDataError(
        `Price policy rejected promotional price below the pre-ad break-even floor ${breakEvenFloor.toFixed(2)} ${cost.currency}`,
      );
    }
    return {
      ...scopedDraft,
      policy: {
        policy_status: 'allowed' as const,
        policy_version: 'price-promotion-floor-v1',
        minimum_promotional_price: minimumPromotionalPrice,
        pre_ad_break_even_floor: breakEvenFloor,
        currency: draft.currency,
        limitation:
          'Pre-ad cost floor only; not a demand forecast or guaranteed profit.',
      },
    };
  }

  if (
    input.actionType === 'replenish_inventory' ||
    input.actionType === 'pause_listing'
  ) {
    const investigation = investigateSku(dataset, window, referenceTime);
    if (
      investigation.warnings.includes('inventory_data_is_stale') ||
      investigation.warnings.includes('inventory_timestamp_is_in_future')
    ) {
      throw new EcommerceDataError(
        'Policy rejected because the inventory snapshot is stale or in the future',
      );
    }
    if (investigation.status !== 'ready_for_recommendation') {
      throw new EcommerceDataError(
        'Policy requires complete investigation evidence',
      );
    }
    const product = requireProduct(dataset, input.skuId, input.site);
    if (product.status !== 'active') {
      throw new EcommerceDataError('Policy requires an active listing');
    }
    if (input.actionType === 'pause_listing') {
      if (
        investigation.profit.profit >= 0 &&
        investigation.inventory.available > 0
      ) {
        throw new EcommerceDataError(
          'Listing pause policy found no measured margin or stock risk',
        );
      }
      return {
        ...scopedDraft,
        policy: {
          policy_status: 'allowed' as const,
          policy_version: 'listing-pause-risk-v1',
          negative_profit: investigation.profit.profit < 0,
          out_of_stock: investigation.inventory.available === 0,
          limitation:
            'Evidence of risk is not proof that pausing is the best option.',
        },
      };
    }
    const { inventory, sales } = investigation;
    if (input.currentValue !== inventory.available) {
      throw new EcommerceDataError(
        `current_value must match available inventory ${inventory.available}`,
      );
    }
    const sevenDayDemand = Math.ceil(
      (sales.units / sales.date_coverage.expected_date_count) * 7,
    );
    if (sevenDayDemand <= inventory.available + inventory.inbound) {
      throw new EcommerceDataError(
        'Inventory policy found no seven-day stock shortage after inbound units',
      );
    }
    if (
      input.proposedValue === undefined ||
      input.proposedValue <= inventory.available ||
      input.proposedValue > sevenDayDemand
    ) {
      throw new EcommerceDataError(
        `proposed_value must increase available units without exceeding the seven-day demand cap ${sevenDayDemand}`,
      );
    }
    return {
      ...scopedDraft,
      policy: {
        policy_status: 'allowed' as const,
        policy_version: 'inventory-seven-day-cover-v1',
        seven_day_demand_cap: sevenDayDemand,
        inbound_units: inventory.inbound,
        suggested_order_units: Math.max(
          0,
          input.proposedValue - inventory.available - inventory.inbound,
        ),
        limitation: 'Historical seven-day run rate is not a demand forecast.',
      },
    };
  }

  const sales = querySales(dataset, window);
  const ads = queryAds(dataset, window);
  const profit = calculateProfit(dataset, window);
  if (!sales.date_coverage.complete || !ads.date_coverage.complete) {
    throw new EcommerceDataError(
      'Ad budget policy rejected the draft because daily evidence coverage is incomplete',
    );
  }
  if (sales.revenue <= 0) {
    throw new EcommerceDataError(
      'Ad budget policy rejected the draft because revenue is not positive',
    );
  }
  if (ads.current_daily_budget === null) {
    throw new EcommerceDataError(
      'Ad budget policy rejected the draft because current daily budget is unavailable',
    );
  }
  if (
    input.currentValue === undefined ||
    Math.abs(input.currentValue - ads.current_daily_budget) > 1e-6
  ) {
    throw new EcommerceDataError(
      `current_value must match the latest observed daily budget ${ads.current_daily_budget}`,
    );
  }
  if (draft.currency !== profit.currency || draft.currency !== ads.currency) {
    throw new EcommerceDataError(
      `currency must match the evidence currency ${profit.currency}`,
    );
  }

  const days = sales.date_coverage.expected_date_count;
  const preAdContribution = profit.profit + ads.spend;
  const preAdMarginRate = preAdContribution / sales.revenue;
  if (preAdMarginRate < 0) {
    throw new EcommerceDataError(
      'Ad budget policy rejected the draft because pre-ad contribution margin is negative',
    );
  }
  const attributedContributionCap = ads.attributed_sales * preAdMarginRate;
  const overallBreakEvenCap = preAdContribution;
  const maxDailyBudget =
    Math.min(attributedContributionCap, overallBreakEvenCap) / days;
  if (
    input.proposedValue === undefined ||
    input.proposedValue > maxDailyBudget + 1e-6
  ) {
    throw new EcommerceDataError(
      `proposed_value exceeds the policy maximum daily budget ${maxDailyBudget.toFixed(2)} ${profit.currency}`,
    );
  }

  return {
    ...scopedDraft,
    policy: {
      policy_status: 'allowed' as const,
      policy_version: 'ad-budget-profit-guard-v1',
      window: {
        start_date: window.startDate,
        end_date: window.endDate,
        days,
      },
      pre_ad_contribution: preAdContribution,
      pre_ad_margin_rate: preAdMarginRate,
      attributed_contribution_cap: attributedContributionCap,
      overall_break_even_cap: overallBreakEvenCap,
      max_daily_budget: maxDailyBudget,
      currency: profit.currency,
      formula:
        'min(attributed_sales * pre_ad_margin_rate, pre_ad_contribution) / window_days',
    },
  };
}

const actionIdSchema = z.string().regex(/^action-[0-9a-f-]{36}$/);

export function persistActionDraft(dataDir: string, draft: object) {
  const actionId = (draft as { action_id?: unknown }).action_id;
  if (
    typeof actionId !== 'string' ||
    !actionIdSchema.safeParse(actionId).success
  ) {
    throw new EcommerceDataError('Invalid action_id');
  }
  const now = new Date().toISOString();
  const record = {
    ...draft,
    revision: 1,
    created_at: now,
    updated_at: now,
  };
  const actionsDir = path.join(dataDir, '.actions');
  fs.mkdirSync(actionsDir, { recursive: true, mode: 0o700 });
  const target = path.join(actionsDir, `${actionId}.json`);
  const temporary = path.join(
    actionsDir,
    `.${actionId}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw new EcommerceDataError(
      `Unable to persist action draft: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return record;
}

export function readActionDraft(dataDir: string, actionId: string) {
  if (!actionIdSchema.safeParse(actionId).success) {
    throw new EcommerceDataError('Invalid action_id');
  }
  const actionFile = path.join(dataDir, '.actions', `${actionId}.json`);
  if (!fs.existsSync(actionFile)) {
    throw new EcommerceDataError(`Unknown action_id: ${actionId}`);
  }
  try {
    return JSON.parse(fs.readFileSync(actionFile, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new EcommerceDataError(
      `Unable to read action draft: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function appendTrace(
  options: EcommerceToolOptions,
  toolName: string,
  evidence: string[],
  warnings: string[],
  value?: unknown,
): { trace_id: string; persisted: boolean; warning?: string } {
  const traceId = `trace-${crypto.randomUUID()}`;
  const result =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const trace = {
    trace_id: traceId,
    tool: toolName,
    created_at: new Date().toISOString(),
    input_turn_id: options.getInputTurnId
      ? options.getInputTurnId()
      : (options.inputTurnId ?? null),
    session_id: options.getSessionId
      ? options.getSessionId()
      : (options.sessionId ?? null),
    prompt_plan_hash: options.getPromptPlanHash?.() ?? null,
    evidence,
    warnings,
    sku_id: typeof result.sku_id === 'string' ? result.sku_id : null,
    site: typeof result.site === 'string' ? result.site : null,
    start_date:
      typeof result.start_date === 'string' ? result.start_date : null,
    end_date: typeof result.end_date === 'string' ? result.end_date : null,
    status: typeof result.status === 'string' ? result.status : null,
    review_result: toolName === 'ecommerce_review_windows' ? value : null,
    dataset_hash: null as string | null,
  };
  try {
    trace.dataset_hash = hashDataset(options.dataDir);
    const traceDir = path.join(options.dataDir, '.traces');
    fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(traceDir, 'tool-traces.jsonl'),
      `${JSON.stringify(trace)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return { trace_id: traceId, persisted: true };
  } catch (error) {
    return {
      trace_id: traceId,
      persisted: false,
      warning: `trace_not_persisted: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function hashDataset(dataDir: string): string {
  const hash = crypto.createHash('sha256');
  for (const filename of REQUIRED_DATA_FILES) {
    hash.update(filename);
    hash.update(fs.readFileSync(path.join(dataDir, filename)));
  }
  return hash.digest('hex');
}

export function recordEcommerceTrace(
  options: EcommerceToolOptions,
  toolName: string,
  value: unknown,
): { trace_id: string; persisted: boolean; warning?: string } {
  return appendTrace(options, toolName, [...REQUIRED_DATA_FILES], [], value);
}

export function assertEvidenceTracesExist(
  dataDir: string,
  evidenceTraceIds: string[],
  scope?: EvidenceScope,
): void {
  const traceFile = path.join(dataDir, '.traces', 'tool-traces.jsonl');
  if (!fs.existsSync(traceFile)) {
    throw new EcommerceDataError(
      'No persisted tool traces exist for this action draft',
    );
  }
  let traces: Array<Record<string, unknown>>;
  try {
    traces = fs
      .readFileSync(traceFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    throw new EcommerceDataError(
      `Unable to validate evidence traces: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const selected = evidenceTraceIds.map((traceId) =>
    traces.find((trace) => trace.trace_id === traceId),
  );
  const missingIds = evidenceTraceIds.filter((_, index) => !selected[index]);
  if (missingIds.length > 0) {
    throw new EcommerceDataError(
      `Unknown evidence_trace_ids: ${missingIds.join(', ')}`,
    );
  }
  if (!scope) return;
  const currentHash = hashDataset(dataDir);
  for (const trace of selected) {
    if (!trace) continue;
    if (
      scope.promptPlanHash !== undefined &&
      scope.promptPlanHash !== null &&
      trace.prompt_plan_hash !== scope.promptPlanHash
    ) {
      throw new EcommerceDataError(
        'Evidence trace PromptPlan does not match the current PromptPlan',
      );
    }
    if (
      trace.sku_id !== scope.skuId ||
      trace.site !== scope.site ||
      trace.start_date !== scope.startDate ||
      trace.end_date !== scope.endDate ||
      trace.dataset_hash !== currentHash ||
      (scope.sessionId && trace.session_id !== scope.sessionId)
    ) {
      throw new EcommerceDataError(
        'Evidence trace does not match SKU, site, window, session, or current dataset',
      );
    }
  }
  if (
    !selected.some(
      (trace) =>
        trace?.tool === 'ecommerce_investigate_sku' &&
        trace.status === 'ready_for_recommendation',
    )
  ) {
    throw new EcommerceDataError(
      'A complete ecommerce_investigate_sku trace is required',
    );
  }
}

function jsonResult(value: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function toolError(error: unknown): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function tracedResult(
  options: EcommerceToolOptions,
  toolName: string,
  value: unknown,
  evidence: string[],
  warnings: string[] = [],
): McpToolResult {
  return jsonResult({
    data: value,
    trace: appendTrace(options, toolName, evidence, warnings, value),
  });
}

const windowShape = {
  sku_id: z.string().trim().min(1),
  site: siteSchema.optional(),
  start_date: dateSchema,
  end_date: dateSchema,
};

export function createEcommerceTools(
  options: EcommerceToolOptions,
): McpToolDefinition<any>[] {
  return [
    defineMcpTool(
      'ecommerce_dataset_status',
      'Inspect the local ecommerce CSV dataset and report available tables and row counts. Use before an investigation to verify evidence availability.',
      {},
      async () => {
        try {
          const dataset = loadEcommerceDataset(options.dataDir);
          return tracedResult(
            options,
            'ecommerce_dataset_status',
            {
              data_dir: options.dataDir,
              row_counts: Object.fromEntries(
                Object.entries(dataset).map(([name, rows]) => [
                  name,
                  rows.length,
                ]),
              ),
            },
            [...REQUIRED_DATA_FILES],
          );
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_query_sales',
      'Query read-only SKU sales evidence for an inclusive date window. Call before making demand, inventory, or profit claims.',
      windowShape,
      async (args) => {
        try {
          const value = querySales(loadEcommerceDataset(options.dataDir), {
            skuId: args.sku_id,
            site: args.site,
            startDate: args.start_date,
            endDate: args.end_date,
          });
          return tracedResult(options, 'ecommerce_query_sales', value, [
            'products.csv',
            'sales.csv',
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_query_inventory',
      'Query the latest read-only inventory snapshot for one SKU. The result includes its source timestamp so stale evidence can be rejected.',
      {
        sku_id: z.string().trim().min(1),
        site: siteSchema.optional(),
      },
      async (args) => {
        try {
          const value = queryInventory(
            loadEcommerceDataset(options.dataDir),
            args.sku_id,
            args.site,
          );
          return tracedResult(options, 'ecommerce_query_inventory', value, [
            'products.csv',
            'inventory.csv',
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_query_ads',
      'Query read-only SKU advertising evidence for an inclusive date window and derive CTR, CPC, and ROAS without changing campaign state.',
      windowShape,
      async (args) => {
        try {
          const value = queryAds(loadEcommerceDataset(options.dataDir), {
            skuId: args.sku_id,
            site: args.site,
            startDate: args.start_date,
            endDate: args.end_date,
          });
          return tracedResult(options, 'ecommerce_query_ads', value, [
            'products.csv',
            'ads.csv',
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_calculate_profit',
      'Calculate SKU contribution profit from sales, advertising, product, fulfillment, and platform-fee evidence. Fails closed on currency mismatch.',
      windowShape,
      async (args) => {
        try {
          const value = calculateProfit(loadEcommerceDataset(options.dataDir), {
            skuId: args.sku_id,
            site: args.site,
            startDate: args.start_date,
            endDate: args.end_date,
          });
          return tracedResult(options, 'ecommerce_calculate_profit', value, [
            'products.csv',
            'sales.csv',
            'ads.csv',
            'costs.csv',
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_investigate_sku',
      'Run the read-only investigation sequence sales and inventory, advertising and promotions, profit constraints, then evidence completeness. Never executes a business action.',
      {
        ...windowShape,
        reference_time: dateTimeSchema.optional(),
      },
      async (args) => {
        try {
          const value = investigateSku(
            loadEcommerceDataset(options.dataDir),
            {
              skuId: args.sku_id,
              site: args.site,
              startDate: args.start_date,
              endDate: args.end_date,
            },
            args.reference_time ?? new Date().toISOString(),
          );
          return tracedResult(
            options,
            'ecommerce_investigate_sku',
            value,
            [...REQUIRED_DATA_FILES],
            value.warnings,
          );
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_monitor',
      'Detect SKU-level margin, advertising, promotion, and inventory signals across a local dataset. Read-only; incomplete evidence becomes an alert, not an action.',
      {
        site: siteSchema.optional(),
        start_date: dateSchema,
        end_date: dateSchema,
        reference_time: dateTimeSchema.optional(),
      },
      async (args) => {
        try {
          const value = monitorEcommerce(
            loadEcommerceDataset(options.dataDir),
            {
              site: args.site,
              startDate: args.start_date,
              endDate: args.end_date,
            },
            args.reference_time ?? new Date().toISOString(),
          );
          return tracedResult(options, 'ecommerce_monitor', value, [
            ...REQUIRED_DATA_FILES,
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_compare_ad_budget_options',
      'Compare hold, reduce-to-policy-limit, and pause-ad-spend scenarios. All profit estimates assume unchanged sales and are not forecasts or executable actions.',
      { ...windowShape, reference_time: dateTimeSchema.optional() },
      async (args) => {
        try {
          const value = compareAdBudgetOptions(
            loadEcommerceDataset(options.dataDir),
            {
              skuId: args.sku_id,
              site: args.site,
              startDate: args.start_date,
              endDate: args.end_date,
            },
            args.reference_time ?? new Date().toISOString(),
          );
          return tracedResult(
            options,
            'ecommerce_compare_ad_budget_options',
            value,
            [...REQUIRED_DATA_FILES],
          );
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_review_windows',
      'Compare before and after evidence windows for the same SKU and site. Observational only; cannot prove approval, execution, or causality.',
      {
        sku_id: z.string().trim().min(1),
        site: siteSchema,
        before_start_date: dateSchema,
        before_end_date: dateSchema,
        after_start_date: dateSchema,
        after_end_date: dateSchema,
      },
      async (args) => {
        try {
          const value = reviewEcommerceWindows(
            loadEcommerceDataset(options.dataDir),
            {
              skuId: args.sku_id,
              site: args.site,
              startDate: args.before_start_date,
              endDate: args.before_end_date,
            },
            {
              skuId: args.sku_id,
              site: args.site,
              startDate: args.after_start_date,
              endDate: args.after_end_date,
            },
          );
          return tracedResult(options, 'ecommerce_review_windows', value, [
            ...REQUIRED_DATA_FILES,
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_draft_action',
      'Evaluate action-specific policy and persist a non-executable draft after evidence review. Budget, price, replenishment, and listing-pause drafts must pass their evidence and safety guards. Every action still requires human approval.',
      {
        sku_id: z.string().trim().min(1),
        site: siteSchema,
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        action_type: z.enum(actionTypes),
        unit: z.enum(actionUnits),
        currency: currencySchema.optional(),
        reason: z.string().trim().min(1).max(2_000),
        evidence_trace_ids: z.array(z.string().trim().min(1)).min(1).max(50),
        current_value: z.number().finite().min(0).optional(),
        proposed_value: z.number().finite().min(0).optional(),
      },
      async (args) => {
        try {
          if (!args.start_date || !args.end_date) {
            throw new EcommerceDataError(
              'start_date and end_date are required for evidence validation',
            );
          }
          assertEvidenceTracesExist(options.dataDir, args.evidence_trace_ids, {
            skuId: args.sku_id,
            site: args.site,
            startDate: args.start_date,
            endDate: args.end_date,
            sessionId: options.getSessionId
              ? options.getSessionId()
              : options.sessionId,
            promptPlanHash: options.getPromptPlanHash?.() ?? null,
          });
          const dataset = loadEcommerceDataset(options.dataDir);
          const draft = draftGovernedAction(
            dataset,
            {
              skuId: args.sku_id,
              site: args.site,
              actionType: args.action_type,
              unit: args.unit,
              currency: args.currency,
              reason: args.reason,
              evidenceTraceIds: args.evidence_trace_ids,
              currentValue: args.current_value,
              proposedValue: args.proposed_value,
            },
            args.start_date && args.end_date
              ? {
                  skuId: args.sku_id,
                  site: args.site,
                  startDate: args.start_date,
                  endDate: args.end_date,
                }
              : undefined,
          );
          const value = persistActionDraft(options.dataDir, draft);
          return tracedResult(options, 'ecommerce_draft_action', value, [
            ...args.evidence_trace_ids,
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
    defineMcpTool(
      'ecommerce_action_status',
      'Read one persisted action draft and its approval-required status. This tool cannot approve or execute the action.',
      {
        action_id: actionIdSchema,
      },
      async (args) => {
        try {
          const value = readActionDraft(options.dataDir, args.action_id);
          return tracedResult(options, 'ecommerce_action_status', value, [
            `.actions/${args.action_id}.json`,
          ]);
        } catch (error) {
          return toolError(error);
        }
      },
    ),
  ];
}
