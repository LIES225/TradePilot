import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import {
  bindEcommerceApprovalDatabase,
  createEcommerceApprovalSchema,
  decideEcommerceAction,
  getEcommerceActionReview,
  getEcommerceManualExecution,
  getEcommerceOutcomeReview,
  hashEcommerceDraft,
  recordEcommerceManualExecution,
  recordEcommerceOutcomeReview,
} from '../src/ecommerce-approval-store.js';

const db = new Database(':memory:');
createEcommerceApprovalSchema(db);
bindEcommerceApprovalDatabase(db);

afterEach(() => {
  db.exec('DELETE FROM ecommerce_outcome_reviews');
  db.exec('DELETE FROM ecommerce_manual_executions');
  db.exec('DELETE FROM ecommerce_action_reviews');
});

describe('ecommerce human decision ledger', () => {
  test('binds approval to a specific draft hash and reviewer', () => {
    const draftHash = hashEcommerceDraft('{"proposed_value":3}');
    const review = decideEcommerceAction({
      workspaceJid: 'web:tradepilot',
      actionId: 'action-test',
      draftHash,
      decision: 'approved',
      reviewerUserId: 'human-1',
      reason: 'Evidence and margin checked',
    });
    expect(review).toMatchObject({
      decision: 'approved',
      draft_hash: draftHash,
      reviewer_user_id: 'human-1',
    });
    expect(getEcommerceActionReview('web:tradepilot', 'action-test')).toEqual(
      review,
    );
    expect(getEcommerceActionReview('web:other', 'action-test')).toBeNull();
    expect(hashEcommerceDraft('{"proposed_value":4}')).not.toBe(draftHash);
  });

  test('does not permit a second or changed decision', () => {
    const initial = {
      workspaceJid: 'web:tradepilot',
      actionId: 'action-test',
      draftHash: hashEcommerceDraft('draft'),
      reviewerUserId: 'human-1',
      reason: 'Initial review',
    };
    expect(
      decideEcommerceAction({ ...initial, decision: 'rejected' }),
    ).not.toBeNull();
    expect(
      decideEcommerceAction({ ...initial, decision: 'approved' }),
    ).toBeNull();
    expect(
      getEcommerceActionReview(initial.workspaceJid, initial.actionId)
        ?.decision,
    ).toBe('rejected');
  });

  test('schema creation is compatible with an existing database', () => {
    expect(() => createEcommerceApprovalSchema(db)).not.toThrow();
  });

  test('workspace and action lookups use composite primary-key indexes', () => {
    for (const table of [
      'ecommerce_action_reviews',
      'ecommerce_manual_executions',
      'ecommerce_outcome_reviews',
    ]) {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT action_id FROM ${table} WHERE workspace_jid = ? AND action_id = ?`,
        )
        .all('web:tradepilot', 'action-test') as Array<{ detail: string }>;
      expect(
        plan.some(
          (row) =>
            row.detail.includes('SEARCH') && row.detail.includes('INDEX'),
        ),
      ).toBe(true);
    }
  });

  test('only an approved matching draft can be manually recorded and reviewed once', () => {
    const workspaceJid = 'web:tradepilot';
    const actionId = 'action-lifecycle';
    const draftHash = hashEcommerceDraft('approved-draft');
    const executionInput = {
      workspaceJid,
      actionId,
      draftHash,
      operatorUserId: 'human-1',
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
      externalReference: 'seller-console-123',
      note: 'Adjusted manually',
    };
    expect(recordEcommerceManualExecution(executionInput)).toBeNull();
    decideEcommerceAction({
      workspaceJid,
      actionId: 'action-rejected',
      draftHash,
      decision: 'rejected',
      reviewerUserId: 'human-1',
      reason: 'Unsafe',
    });
    expect(
      recordEcommerceManualExecution({
        ...executionInput,
        actionId: 'action-rejected',
      }),
    ).toBeNull();
    decideEcommerceAction({
      workspaceJid,
      actionId,
      draftHash,
      decision: 'approved',
      reviewerUserId: 'human-1',
      reason: 'Reviewed',
    });
    expect(
      recordEcommerceManualExecution({ ...executionInput, draftHash: 'wrong' }),
    ).toBeNull();
    expect(recordEcommerceManualExecution(executionInput)).toMatchObject({
      external_reference: 'seller-console-123',
    });
    expect(recordEcommerceManualExecution(executionInput)).toBeNull();
    expect(
      getEcommerceManualExecution(workspaceJid, actionId)?.operator_user_id,
    ).toBe('human-1');

    const reviewInput = {
      workspaceJid,
      actionId,
      draftHash,
      reviewerUserId: 'human-1',
      datasetHash: 'dataset-hash',
      result: { status: 'observed' },
    };
    expect(
      recordEcommerceOutcomeReview({ ...reviewInput, draftHash: 'wrong' }),
    ).toBeNull();
    expect(recordEcommerceOutcomeReview(reviewInput)?.result).toEqual({
      status: 'observed',
    });
    expect(recordEcommerceOutcomeReview(reviewInput)).toBeNull();
    expect(
      getEcommerceOutcomeReview(workspaceJid, actionId)?.dataset_hash,
    ).toBe('dataset-hash');
  });
});
