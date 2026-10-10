import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v70-ecommerce-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const approval = await import('../src/ecommerce-approval-store.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v70 ecommerce decision migration', () => {
  test('upgrades a v69 database and preserves an unrelated row', () => {
    db.initDatabase();
    db.setRouterState('ecommerce-migration-sentinel', 'preserved');
    db.closeDatabase();

    const file = path.join(storeDir, 'messages.db');
    const legacy = new Database(file);
    legacy
      .prepare(
        "UPDATE router_state SET value = '69' WHERE key = 'schema_version'",
      )
      .run();
    legacy.close();

    db.initDatabase();
    expect(db.getRouterState('ecommerce-migration-sentinel')).toBe('preserved');
    expect(db.getRouterState('schema_version')).toBe(String(db.CURRENT_SCHEMA_VERSION));
    const review = approval.decideEcommerceAction({
      workspaceJid: 'web:tradepilot',
      actionId: 'action-v70',
      draftHash: approval.hashEcommerceDraft('draft'),
      decision: 'rejected',
      reviewerUserId: 'human',
      reason: 'Insufficient evidence',
    });
    expect(review?.decision).toBe('rejected');
  });
});
