import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  calculateProfit,
  createEcommerceTools,
  draftGovernedAction,
  hashDataset,
  investigateSku,
  loadEcommerceDataset,
  querySales,
} from '../container/agent-runner/src/ecommerce-tools.js';

const files = [
  'products.csv',
  'sales.csv',
  'inventory.csv',
  'ads.csv',
  'promotions.csv',
  'costs.csv',
] as const;
const window = {
  skuId: 'SKU-LOW',
  site: 'US',
  startDate: '2026-09-01',
  endDate: '2026-09-07',
};
const referenceTime = '2026-09-08T12:00:00Z';

type CaseCategory = 'normal' | 'abnormal' | 'ambiguous' | 'safety';
interface Observation {
  status: string;
  markers: string[];
}
interface EvalCase {
  id: string;
  category: CaseCategory;
  description: string;
  evidence: readonly string[];
  expectedStatus: string;
  requiredMarkers?: readonly string[];
  forbiddenMarkers?: readonly string[];
  prepare?: (dataDir: string) => void;
  run: (dataDir: string) => Observation;
}

export interface EcommerceEvalCaseResult {
  id: string;
  category: CaseCategory;
  description: string;
  passed: boolean;
  expected: {
    status: string;
    required_markers: readonly string[];
    forbidden_markers: readonly string[];
  };
  observed: Observation;
  evidence: readonly string[];
  dataset_hash: string;
}

export interface EcommerceEvalReport {
  suite: 'tradepilot-ecommerce-tool-contract-v1';
  evaluation_level: 'deterministic_tool_contract';
  model_answer_quality_measured: false;
  cases: EcommerceEvalCaseResult[];
  passed: number;
  failed: number;
  gate_passed: boolean;
}

function reject(operation: () => unknown): Observation {
  try {
    operation();
    return { status: 'accepted', markers: [] };
  } catch (error) {
    return {
      status: 'rejected',
      markers: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function investigate(dataDir: string, at = referenceTime): Observation {
  const result = investigateSku(loadEcommerceDataset(dataDir), window, at);
  return {
    status: result.status,
    markers: [
      ...result.findings,
      ...result.warnings,
      ...result.missing_material,
    ],
  };
}

function replaceFile(
  dataDir: string,
  filename: string,
  from: string,
  to: string,
): void {
  const file = path.join(dataDir, filename);
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(from))
    throw new Error(`Eval fixture missing ${from} in ${filename}`);
  fs.writeFileSync(file, source.replace(from, to));
}

const cases: readonly EvalCase[] = [
  {
    id: 'complete-investigation',
    category: 'normal',
    description:
      'Complete daily evidence identifies margin, advertising and promotion signals',
    evidence: [
      'sales.csv',
      'inventory.csv',
      'ads.csv',
      'promotions.csv',
      'costs.csv',
    ],
    expectedStatus: 'ready_for_recommendation',
    requiredMarkers: [
      'negative_margin',
      'low_ad_roas',
      'overlapping_promotions',
    ],
    run: investigate,
  },
  {
    id: 'missing-sales-day',
    category: 'abnormal',
    description: 'An absent daily row is missing evidence, not zero sales',
    evidence: ['sales.csv'],
    expectedStatus: 'needs_more_evidence',
    requiredMarkers: [
      'sales_date_coverage_incomplete',
      'sales.csv:US:SKU-LOW:2026-09-03',
    ],
    prepare: (dir) =>
      replaceFile(dir, 'sales.csv', '2026-09-03,SKU-LOW,US,0,0,USD\n', ''),
    run: investigate,
  },
  {
    id: 'duplicate-sales-day',
    category: 'abnormal',
    description: 'A repeated SKU-site-day row cannot double-count revenue',
    evidence: ['sales.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['sales.csv row', 'duplicate business key'],
    prepare: (dir) =>
      fs.appendFileSync(
        path.join(dir, 'sales.csv'),
        '2026-09-01,SKU-LOW,US,99,999,USD\n',
      ),
    run: (dir) => reject(() => loadEcommerceDataset(dir)),
  },
  {
    id: 'stale-inventory',
    category: 'abnormal',
    description: 'An old inventory snapshot blocks a ready recommendation',
    evidence: ['inventory.csv'],
    expectedStatus: 'needs_more_evidence',
    requiredMarkers: ['inventory_data_is_stale'],
    run: (dir) => investigate(dir, '2026-09-10T12:00:00Z'),
  },
  {
    id: 'sequential-promotions',
    category: 'ambiguous',
    description: 'Adjacent promotions are not mislabeled as overlapping',
    evidence: ['promotions.csv'],
    expectedStatus: 'ready_for_recommendation',
    forbiddenMarkers: ['overlapping_promotions'],
    prepare: (dir) => {
      const file = path.join(dir, 'promotions.csv');
      fs.writeFileSync(
        file,
        [
          'sku_id,site,start_date,end_date,discount_type,discount_value',
          'SKU-LOW,US,2026-09-01,2026-09-03,percentage,10',
          'SKU-LOW,US,2026-09-04,2026-09-07,fixed,2',
          '',
        ].join('\n'),
      );
    },
    run: investigate,
  },
  {
    id: 'cross-site-sku',
    category: 'ambiguous',
    description: 'The same SKU at two sites requires an explicit site',
    evidence: ['products.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['site is required'],
    prepare: (dir) =>
      fs.appendFileSync(
        path.join(dir, 'products.csv'),
        'SKU-LOW,UK,Travel Bottle UK,active,20,GBP\n',
      ),
    run: (dir) =>
      reject(() =>
        querySales(loadEcommerceDataset(dir), {
          skuId: 'SKU-LOW',
          startDate: window.startDate,
          endDate: window.endDate,
        }),
      ),
  },
  {
    id: 'bundle-cost-basis',
    category: 'abnormal',
    description: 'A bundle cannot inherit per-component cost as total cost',
    evidence: ['products.csv', 'costs.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['bundle_total'],
    prepare: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'products.csv'),
        [
          'sku_id,site,title,status,bundle_components',
          'SKU-LOW,US,Travel Bottle,active,',
          'SKU-HEALTHY,US,Desk Organizer,active,',
          'BUNDLE-1,US,Travel Kit,active,SKU-LOW*2',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(dir, 'costs.csv'),
        [
          'sku_id,site,currency,unit_cost,fulfillment_cost,platform_fee_rate,cost_basis',
          'SKU-LOW,US,USD,9,3,0.15,sku_unit',
          'SKU-HEALTHY,US,USD,8,2,0.15,sku_unit',
          'BUNDLE-1,US,USD,18,4,0.15,sku_unit',
          '',
        ].join('\n'),
      );
    },
    run: (dir) =>
      reject(() =>
        calculateProfit(loadEcommerceDataset(dir), {
          ...window,
          skuId: 'BUNDLE-1',
        }),
      ),
  },
  {
    id: 'currency-conflict',
    category: 'abnormal',
    description: 'Conflicting cost and revenue currencies fail closed',
    evidence: ['sales.csv', 'costs.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['Currency mismatch'],
    prepare: (dir) =>
      replaceFile(
        dir,
        'costs.csv',
        'SKU-LOW,US,USD,9,3,0.15',
        'SKU-LOW,US,CNY,9,3,0.15',
      ),
    run: (dir) =>
      reject(() => calculateProfit(loadEcommerceDataset(dir), window)),
  },
  {
    id: 'profit-guard-rejection',
    category: 'safety',
    description: 'A budget above the contribution guard is rejected',
    evidence: ['sales.csv', 'ads.csv', 'costs.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['maximum daily budget'],
    run: (dir) =>
      reject(() =>
        draftGovernedAction(
          loadEcommerceDataset(dir),
          {
            skuId: 'SKU-LOW',
            site: 'US',
            actionType: 'adjust_ad_budget',
            unit: 'currency_per_day',
            currency: 'USD',
            reason: 'Limit advertising loss',
            evidenceTraceIds: ['eval-evidence'],
            currentValue: 37.5,
            proposedValue: 10,
          },
          window,
        ),
      ),
  },
  {
    id: 'price-promotion-floor',
    category: 'safety',
    description: 'A price below the stacked-promotion cost floor is rejected',
    evidence: ['products.csv', 'promotions.csv', 'costs.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['promotional price below the pre-ad break-even floor'],
    run: (dir) =>
      reject(() =>
        draftGovernedAction(
          loadEcommerceDataset(dir),
          {
            skuId: 'SKU-LOW',
            site: 'US',
            actionType: 'adjust_price',
            unit: 'currency_per_unit',
            currency: 'USD',
            reason: 'Evaluate price floor',
            evidenceTraceIds: ['eval-evidence'],
            currentValue: 20,
            proposedValue: 17,
          },
          window,
        ),
      ),
  },
  {
    id: 'stale-inventory-action',
    category: 'safety',
    description: 'A replenishment draft cannot use an old stock snapshot',
    evidence: ['inventory.csv', 'sales.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['inventory snapshot is stale'],
    run: (dir) =>
      reject(() =>
        draftGovernedAction(
          loadEcommerceDataset(dir),
          {
            skuId: 'SKU-LOW',
            site: 'US',
            actionType: 'replenish_inventory',
            unit: 'units',
            reason: 'Evaluate stock cover',
            evidenceTraceIds: ['eval-evidence'],
            currentValue: 4,
            proposedValue: 9,
          },
          window,
          '2026-09-10T12:00:00Z',
        ),
      ),
  },
  {
    id: 'unjustified-listing-pause',
    category: 'safety',
    description:
      'A healthy listing has no measured risk to justify a pause draft',
    evidence: ['sales.csv', 'inventory.csv', 'ads.csv', 'costs.csv'],
    expectedStatus: 'rejected',
    requiredMarkers: ['no measured margin or stock risk'],
    run: (dir) =>
      reject(() =>
        draftGovernedAction(
          loadEcommerceDataset(dir),
          {
            skuId: 'SKU-HEALTHY',
            site: 'US',
            actionType: 'pause_listing',
            unit: 'listing_state',
            reason: 'Evaluate pause request',
            evidenceTraceIds: ['eval-evidence'],
          },
          { ...window, skuId: 'SKU-HEALTHY' },
          referenceTime,
        ),
      ),
  },
  {
    id: 'safe-draft-is-not-execution',
    category: 'safety',
    description:
      'An allowed budget proposal remains approval-required and non-executable',
    evidence: ['sales.csv', 'ads.csv', 'costs.csv'],
    expectedStatus: 'approval_required',
    requiredMarkers: ['executable:false', 'policy:allowed'],
    run: (dir) => {
      const draft = draftGovernedAction(
        loadEcommerceDataset(dir),
        {
          skuId: 'SKU-LOW',
          site: 'US',
          actionType: 'adjust_ad_budget',
          unit: 'currency_per_day',
          currency: 'USD',
          reason: 'Limit advertising loss',
          evidenceTraceIds: ['eval-evidence'],
          currentValue: 37.5,
          proposedValue: 3,
        },
        window,
      );
      return {
        status: draft.status,
        markers: [
          `executable:${draft.executable}`,
          `policy:${draft.policy.policy_status}`,
        ],
      };
    },
  },
  {
    id: 'no-agent-approval-tool',
    category: 'safety',
    description: 'The Agent tool surface has no approve or execute action',
    evidence: ['ecommerce tool registry'],
    expectedStatus: 'restricted',
    requiredMarkers: ['approve:false', 'execute:false'],
    run: (dir) => {
      const names = createEcommerceTools({ dataDir: dir }).map(
        (item) => item.name,
      );
      return {
        status: 'restricted',
        markers: [
          `approve:${names.some((name) => /approve/i.test(name))}`,
          `execute:${names.some((name) => /execute/i.test(name))}`,
        ],
      };
    },
  },
] satisfies readonly EvalCase[];

export function evaluateEcommerceCases(
  fixtureDir: string,
): EcommerceEvalReport {
  const results: EcommerceEvalCaseResult[] = [];
  for (const caseDefinition of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepilot-eval-'));
    const dataDir = path.join(root, 'ecommerce-data');
    fs.mkdirSync(dataDir);
    try {
      for (const filename of files) {
        fs.copyFileSync(
          path.join(fixtureDir, filename),
          path.join(dataDir, filename),
        );
      }
      caseDefinition.prepare?.(dataDir);
      const datasetHash = hashDataset(dataDir);
      let observed: Observation;
      try {
        observed = caseDefinition.run(dataDir);
      } catch (error) {
        observed = {
          status: 'unexpected_error',
          markers: [error instanceof Error ? error.message : String(error)],
        };
      }
      const required = caseDefinition.requiredMarkers ?? [];
      const forbidden = caseDefinition.forbiddenMarkers ?? [];
      results.push({
        id: caseDefinition.id,
        category: caseDefinition.category,
        description: caseDefinition.description,
        passed:
          observed.status === caseDefinition.expectedStatus &&
          required.every((marker) =>
            observed.markers.some((actual) => actual.includes(marker)),
          ) &&
          forbidden.every((marker) =>
            observed.markers.every((actual) => !actual.includes(marker)),
          ),
        expected: {
          status: caseDefinition.expectedStatus,
          required_markers: required,
          forbidden_markers: forbidden,
        },
        observed,
        evidence: caseDefinition.evidence,
        dataset_hash: datasetHash,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    suite: 'tradepilot-ecommerce-tool-contract-v1',
    evaluation_level: 'deterministic_tool_contract',
    model_answer_quality_measured: false,
    cases: results,
    passed,
    failed: results.length - passed,
    gate_passed: passed === results.length,
  };
}
