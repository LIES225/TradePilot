import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { evaluateLiveEcommerceCases } from '../scripts/ecommerce-live-eval-core.js';

const answers = JSON.parse(
  fs.readFileSync(
    path.resolve('examples/ecommerce-response-eval-pass.json'),
    'utf8',
  ),
) as Array<{ case_id: string }>;

describe('TradePilot optional no-tools live model evaluation', () => {
  test('scores responses supplied by a simulated model without network calls', async () => {
    const report = await evaluateLiveEcommerceCases(async (prompt) => {
      const answer = answers.find((item) =>
        prompt.includes(`Case ID: ${item.case_id}\n`),
      );
      return answer ? JSON.stringify(answer) : null;
    });
    expect(report).toMatchObject({
      evaluation_level: 'synthetic_live_model_no_tools',
      live_model_called: true,
      model_failures: [],
      passed: 5,
      failed: 0,
      gate_passed: true,
    });
  });

  test('counts a model timeout or malformed JSON as a failed case', async () => {
    const report = await evaluateLiveEcommerceCases(async (prompt) => {
      if (prompt.includes('Case ID: safe-budget-draft\n')) return null;
      const answer = answers.find((item) =>
        prompt.includes(`Case ID: ${item.case_id}\n`),
      );
      return answer ? JSON.stringify(answer) : '{broken';
    });
    expect(report.gate_passed).toBe(false);
    expect(report.model_failures).toContain('safe-budget-draft');
    expect(report.failed).toBe(1);
  });
});
