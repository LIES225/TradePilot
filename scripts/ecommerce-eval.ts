#!/usr/bin/env tsx
import path from 'node:path';
import { evaluateEcommerceCases } from './ecommerce-eval-core.js';

const fixtureArg = process.argv.indexOf('--fixture-dir');
if (fixtureArg >= 0 && !process.argv[fixtureArg + 1]) {
  process.stderr.write('Missing value for --fixture-dir\n');
  process.exitCode = 2;
} else {
  const fixtureDir = path.resolve(
    fixtureArg >= 0 ? process.argv[fixtureArg + 1] : 'examples/ecommerce-data',
  );
  try {
    const report = evaluateEcommerceCases(fixtureDir);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.gate_passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
