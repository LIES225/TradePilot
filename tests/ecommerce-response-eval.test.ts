import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  evaluateEcommerceResponses,
  listEcommerceResponseCases,
} from '../scripts/ecommerce-response-eval-core.js';

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve('examples/ecommerce-response-eval-pass.json'),
    'utf8',
  ),
) as unknown[];

describe('TradePilot structured response replay gate', () => {
  test('passes the documented fixture without claiming a live model run', () => {
    const report = evaluateEcommerceResponses(fixture);
    expect(report).toMatchObject({
      evaluation_level: 'structured_response_replay',
      live_model_called: false,
      passed: 5,
      failed: 0,
      gate_passed: true,
    });
    expect(listEcommerceResponseCases()).toHaveLength(5);
  });

  test('rejects fabricated approval, mismatched scope, missing cases and unsafe actions', () => {
    const responses = structuredClone(fixture) as Array<
      Record<string, unknown>
    >;
    responses[0].claims_executed = true;
    responses[1].site = 'US';
    responses[2].action = {
      action_type: 'adjust_price',
      approval_required: false,
      executable: true,
    };
    responses.pop();
    const report = evaluateEcommerceResponses(responses);
    expect(report.gate_passed).toBe(false);
    expect(report.failed).toBe(4);
    expect(
      report.cases.find((item) => item.id === 'missing-sales-evidence')
        ?.violations,
    ).toContain('approval or execution was claimed without proof');
  });

  test('rejects malformed response files before scoring', () => {
    expect(() =>
      evaluateEcommerceResponses([{ case_id: 'missing-sales-evidence' }]),
    ).toThrow(/Invalid response file/);
  });
});
