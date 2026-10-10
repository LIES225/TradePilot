import crypto from 'node:crypto';

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export type EcommerceDecision = 'approved' | 'rejected';

export interface EcommerceActionReview {
  workspace_jid: string;
  action_id: string;
  draft_hash: string;
  decision: EcommerceDecision;
  reviewer_user_id: string;
  reason: string;
  reviewed_at: string;
}

export interface EcommerceManualExecution {
  workspace_jid: string;
  action_id: string;
  draft_hash: string;
  operator_user_id: string;
  occurred_at: string;
  external_reference: string;
  note: string;
  recorded_at: string;
}

export interface EcommerceOutcomeReview {
  workspace_jid: string;
  action_id: string;
  draft_hash: string;
  reviewer_user_id: string;
  dataset_hash: string;
  result: Record<string, unknown>;
  reviewed_at: string;
}

let database: SqliteDatabase | null = null;

export function createEcommerceApprovalSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ecommerce_action_reviews (
      workspace_jid TEXT NOT NULL,
      action_id TEXT NOT NULL,
      draft_hash TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      reviewer_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (workspace_jid, action_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ecommerce_reviews_workspace_time
      ON ecommerce_action_reviews(workspace_jid, reviewed_at DESC);
    CREATE TABLE IF NOT EXISTS ecommerce_manual_executions (
      workspace_jid TEXT NOT NULL,
      action_id TEXT NOT NULL,
      draft_hash TEXT NOT NULL,
      operator_user_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      external_reference TEXT NOT NULL,
      note TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (workspace_jid, action_id),
      FOREIGN KEY (workspace_jid, action_id)
        REFERENCES ecommerce_action_reviews(workspace_jid, action_id)
    );
    CREATE TABLE IF NOT EXISTS ecommerce_outcome_reviews (
      workspace_jid TEXT NOT NULL,
      action_id TEXT NOT NULL,
      draft_hash TEXT NOT NULL,
      reviewer_user_id TEXT NOT NULL,
      dataset_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (workspace_jid, action_id),
      FOREIGN KEY (workspace_jid, action_id)
        REFERENCES ecommerce_manual_executions(workspace_jid, action_id)
    );
  `);
}

export function bindEcommerceApprovalDatabase(db: SqliteDatabase | null): void {
  database = db;
}

function getDatabase(): SqliteDatabase {
  if (!database) throw new Error('Ecommerce approval database is unavailable');
  return database;
}

export function hashEcommerceDraft(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function getEcommerceActionReview(
  workspaceJid: string,
  actionId: string,
): EcommerceActionReview | null {
  return (
    (getDatabase()
      .prepare(
        `SELECT workspace_jid, action_id, draft_hash, decision, reviewer_user_id,
              reason, reviewed_at
       FROM ecommerce_action_reviews
       WHERE workspace_jid = ? AND action_id = ?`,
      )
      .get(workspaceJid, actionId) as EcommerceActionReview | undefined) ?? null
  );
}

export function decideEcommerceAction(input: {
  workspaceJid: string;
  actionId: string;
  draftHash: string;
  decision: EcommerceDecision;
  reviewerUserId: string;
  reason: string;
}): EcommerceActionReview | null {
  const reviewedAt = new Date().toISOString();
  const result = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO ecommerce_action_reviews
       (workspace_jid, action_id, draft_hash, decision, reviewer_user_id, reason, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.workspaceJid,
      input.actionId,
      input.draftHash,
      input.decision,
      input.reviewerUserId,
      input.reason,
      reviewedAt,
    );
  return result.changes === 1
    ? getEcommerceActionReview(input.workspaceJid, input.actionId)
    : null;
}

export function getEcommerceManualExecution(
  workspaceJid: string,
  actionId: string,
): EcommerceManualExecution | null {
  return (
    (getDatabase()
      .prepare(
        `SELECT workspace_jid, action_id, draft_hash, operator_user_id,
            occurred_at, external_reference, note, recorded_at
     FROM ecommerce_manual_executions
     WHERE workspace_jid = ? AND action_id = ?`,
      )
      .get(workspaceJid, actionId) as EcommerceManualExecution | undefined) ??
    null
  );
}

export function recordEcommerceManualExecution(input: {
  workspaceJid: string;
  actionId: string;
  draftHash: string;
  operatorUserId: string;
  occurredAt: string;
  externalReference: string;
  note: string;
}): EcommerceManualExecution | null {
  const result = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO ecommerce_manual_executions
      (workspace_jid, action_id, draft_hash, operator_user_id, occurred_at,
       external_reference, note, recorded_at)
     SELECT workspace_jid, action_id, draft_hash, ?, ?, ?, ?, ?
     FROM ecommerce_action_reviews
     WHERE workspace_jid = ? AND action_id = ? AND draft_hash = ?
       AND decision = 'approved' AND julianday(reviewed_at) <= julianday(?)`,
    )
    .run(
      input.operatorUserId,
      input.occurredAt,
      input.externalReference,
      input.note,
      new Date().toISOString(),
      input.workspaceJid,
      input.actionId,
      input.draftHash,
      input.occurredAt,
    );
  return result.changes === 1
    ? getEcommerceManualExecution(input.workspaceJid, input.actionId)
    : null;
}

export function getEcommerceOutcomeReview(
  workspaceJid: string,
  actionId: string,
): EcommerceOutcomeReview | null {
  const row = getDatabase()
    .prepare(
      `SELECT workspace_jid, action_id, draft_hash, reviewer_user_id,
            dataset_hash, result_json, reviewed_at
     FROM ecommerce_outcome_reviews
     WHERE workspace_jid = ? AND action_id = ?`,
    )
    .get(workspaceJid, actionId) as
    | (Omit<EcommerceOutcomeReview, 'result'> & { result_json: string })
    | undefined;
  if (!row) return null;
  const { result_json, ...record } = row;
  return {
    ...record,
    result: JSON.parse(result_json) as Record<string, unknown>,
  };
}

export function recordEcommerceOutcomeReview(input: {
  workspaceJid: string;
  actionId: string;
  draftHash: string;
  reviewerUserId: string;
  datasetHash: string;
  result: Record<string, unknown>;
}): EcommerceOutcomeReview | null {
  const write = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO ecommerce_outcome_reviews
      (workspace_jid, action_id, draft_hash, reviewer_user_id,
       dataset_hash, result_json, reviewed_at)
     SELECT workspace_jid, action_id, draft_hash, ?, ?, ?, ?
     FROM ecommerce_manual_executions
     WHERE workspace_jid = ? AND action_id = ? AND draft_hash = ?`,
    )
    .run(
      input.reviewerUserId,
      input.datasetHash,
      JSON.stringify(input.result),
      new Date().toISOString(),
      input.workspaceJid,
      input.actionId,
      input.draftHash,
    );
  return write.changes === 1
    ? getEcommerceOutcomeReview(input.workspaceJid, input.actionId)
    : null;
}
