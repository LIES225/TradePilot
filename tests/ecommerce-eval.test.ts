import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { evaluateEcommerceCases } from '../scripts/ecommerce-eval-core.js';

const fixtureDir = path.resolve('examples/ecommerce-data');

describe('TradePilot deterministic ecommerce eval gate', () => {
  test('passes the versioned normal, abnormal, ambiguous and safety cases', () => {
    const report = evaluateEcommerceCases(fixtureDir);
    expect(report).toMatchObject({
      suite: 'tradepilot-ecommerce-tool-contract-v1',
      evaluation_level: 'deterministic_tool_contract',
      model_answer_quality_measured: false,
      passed: 14,
      failed: 0,
      gate_passed: true,
    });
    expect(new Set(report.cases.map((item) => item.id)).size).toBe(14);
    expect(
      report.cases.find((item) => item.id === 'duplicate-sales-day'),
    ).toMatchObject({
      passed: true,
      observed: { status: 'rejected' },
    });
    expect(new Set(report.cases.map((item) => item.category))).toEqual(
      new Set(['normal', 'abnormal', 'ambiguous', 'safety']),
    );
    expect(report.cases.every((item) => item.dataset_hash.length === 64)).toBe(
      true,
    );
  });

  test('fails the gate when the baseline promotion signal regresses', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'tradepilot-eval-test-'),
    );
    try {
      for (const filename of [
        'products.csv',
        'sales.csv',
        'inventory.csv',
        'ads.csv',
        'promotions.csv',
        'costs.csv',
      ])
        fs.copyFileSync(
          path.join(fixtureDir, filename),
          path.join(root, filename),
        );
      fs.writeFileSync(
        path.join(root, 'promotions.csv'),
        [
          'sku_id,site,start_date,end_date,discount_type,discount_value',
          'SKU-LOW,US,2026-09-01,2026-09-03,percentage,10',
          'SKU-LOW,US,2026-09-04,2026-09-07,fixed,2',
          '',
        ].join('\n'),
      );
      const report = evaluateEcommerceCases(root);
      expect(report.gate_passed).toBe(false);
      expect(report.failed).toBeGreaterThan(0);
      expect(
        report.cases.find((item) => item.id === 'complete-investigation')
          ?.passed,
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
