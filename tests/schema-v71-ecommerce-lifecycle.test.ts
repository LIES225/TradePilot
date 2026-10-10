import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v71-ecommerce-'));
const storeDir = path.join(root, 'store');
vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const lifecycle = await import('../src/ecommerce-approval-store.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v71 ecommerce lifecycle migration', () => {
  test('upgrades a v70 database without losing its decision', () => {
    db.initDatabase();
    const draftHash = lifecycle.hashEcommerceDraft('draft');
    lifecycle.decideEcommerceAction({
      workspaceJid: 'web:tradepilot',
      actionId: 'action-1',
      draftHash,
      decision: 'approved',
      reviewerUserId: 'reviewer',
      reason: 'Checked',
    });
    db.closeDatabase();

    const file = path.join(storeDir, 'messages.db');
    const legacy = new Database(file);
    legacy.exec(
      'DROP TABLE ecommerce_outcome_reviews; DROP TABLE ecommerce_manual_executions;',
    );
    legacy
      .prepare(
        "UPDATE router_state SET value = '70' WHERE key = 'schema_version'",
      )
      .run();
    legacy.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('71');
    expect(
      lifecycle.getEcommerceActionReview('web:tradepilot', 'action-1')
        ?.decision,
    ).toBe('approved');
    expect(
      lifecycle.recordEcommerceManualExecution({
        workspaceJid: 'web:tradepilot',
        actionId: 'action-1',
        draftHash,
        operatorUserId: 'reviewer',
        occurredAt: new Date(Date.now() + 1_000).toISOString(),
        externalReference: 'external-1',
        note: 'Manually changed',
      })?.external_reference,
    ).toBe('external-1');
  });
});
