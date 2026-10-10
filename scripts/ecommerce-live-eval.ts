import '../src/load-env.js';

import { sdkQuery } from '../src/sdk-query.js';
import { evaluateLiveEcommerceCases } from './ecommerce-live-eval-core.js';

if (!process.argv.includes('--confirm-live')) {
  process.stderr.write(
    'This command calls the configured model and may incur charges. Run with --confirm-live to proceed.\n',
  );
  process.exitCode = 2;
} else {
  try {
    const report = await evaluateLiveEcommerceCases((prompt) =>
      sdkQuery(prompt, { timeout: 90_000 }),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.gate_passed) process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Live model evaluation failed; provider details were not printed.\n',
    );
    process.exitCode = 2;
  }
}
