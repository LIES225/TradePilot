import fs from 'node:fs';
import path from 'node:path';

import {
  evaluateEcommerceResponses,
  listEcommerceResponseCases,
} from './ecommerce-response-eval-core.js';

if (process.argv.includes('--list-cases')) {
  process.stdout.write(
    `${JSON.stringify(listEcommerceResponseCases(), null, 2)}\n`,
  );
} else {
  const index = process.argv.indexOf('--responses');
  if (index < 0 || !process.argv[index + 1]) {
    process.stderr.write(
      'Usage: npm run ecommerce:response-eval -- --responses <answers.json>\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const file = path.resolve(process.argv[index + 1]);
      const report = evaluateEcommerceResponses(
        JSON.parse(fs.readFileSync(file, 'utf8')),
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.gate_passed) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    }
  }
}
