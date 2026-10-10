import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'miniclaw-ecommerce-review-'),
);
const groupsDir = path.join(root, 'groups');
const storeDir = path.join(root, 'store');
const actionId = 'action-12345678-1234-1234-1234-123456789abc';
const jid = 'web:tradepilot-route-test';
const draft = {
  action_id: actionId,
  sku_id: 'SKU-LOW',
  site: 'US',
  action_type: 'adjust_ad_budget',
  reason: 'Margin is too low',
  evidence_trace_ids: ['trace-1'],
  status: 'approval_required',
  executable: false,
  unit: 'currency_per_day',
  currency: 'USD',
  current_value: 37.5,
  proposed_value: 3,
  evidence_window: {
    start_date: '2026-09-01',
    end_date: '2026-09-07',
  },
  policy: {
    policy_status: 'allowed',
    policy_version: 'ad-budget-profit-guard-v1',
  },
};

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (
    c: {
      req: { header(name: string): string | undefined };
      set(key: string, value: unknown): void;
    },
    next: () => Promise<void>,
  ) => {
    c.set('user', {
      id: c.req.header('x-user') || 'reviewer',
      username: 'reviewer',
      role: 'member',
      permissions: [],
    });
    await next();
  },
}));

const db = await import('../src/db.js');
const ecommerce =
  await import('../container/agent-runner/src/ecommerce-tools.js');
const routes = (await import('../src/routes/workspaces.js')).default;
const dataDir = path.join(groupsDir, 'tradepilot-route-test', 'ecommerce-data');
const actionDir = path.join(dataDir, '.actions');

beforeAll(() => {
  fs.mkdirSync(actionDir, { recursive: true });
  for (const filename of [
    'products.csv',
    'sales.csv',
    'inventory.csv',
    'ads.csv',
    'promotions.csv',
    'costs.csv',
  ]) {
    fs.copyFileSync(
      path.resolve('examples/ecommerce-data', filename),
      path.join(dataDir, filename),
    );
  }
  for (let day = 9; day <= 15; day += 1) {
    const date = `2026-09-${String(day).padStart(2, '0')}`;
    fs.appendFileSync(
      path.join(dataDir, 'sales.csv'),
      `${date},SKU-LOW,US,1,20,USD\n`,
    );
    fs.appendFileSync(
      path.join(dataDir, 'ads.csv'),
      `${date},SKU-LOW,US,3,2,100,5,12,USD\n`,
    );
  }
  db.initDatabase();
  db.setRegisteredGroup(jid, {
    name: 'TradePilot Test',
    folder: 'tradepilot-route-test',
    added_at: new Date().toISOString(),
    created_by: 'reviewer',
    is_home: true,
  });
  const investigation = ecommerce.investigateSku(
    ecommerce.loadEcommerceDataset(dataDir),
    {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    },
    '2026-09-08T12:00:00Z',
  );
  const trace = ecommerce.recordEcommerceTrace(
    { dataDir },
    'ecommerce_investigate_sku',
    investigation,
  );
  draft.evidence_trace_ids = [trace.trace_id];
  fs.writeFileSync(
    path.join(actionDir, `${actionId}.json`),
    JSON.stringify(draft),
  );
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => vi.useRealTimers());

describe('ecommerce human approval routes', () => {
  test('cannot approve a legacy schema-only draft but may reject it', async () => {
    const legacyId = 'action-12345678-1234-1234-1234-123456789abd';
    const legacyFile = path.join(actionDir, `${legacyId}.json`);
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        ...draft,
        action_id: legacyId,
        policy: { policy_status: 'schema_only' },
      }),
    );
    try {
      const list = await routes.request(
        `/${encodeURIComponent(jid)}/ecommerce-actions`,
      );
      const { actions } = await list.json();
      const item = actions.find(
        (entry: { draft: { action_id: string } }) =>
          entry.draft.action_id === legacyId,
      );
      const endpoint = `/${encodeURIComponent(jid)}/ecommerce-actions/${legacyId}/decision`;
      const approved = await routes.request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'approved',
          reason: 'Should fail',
          draft_hash: item.draft_hash,
        }),
      });
      expect(approved.status).toBe(409);
      const rejected = await routes.request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'rejected',
          reason: 'No policy',
          draft_hash: item.draft_hash,
        }),
      });
      expect(rejected.status).toBe(200);
    } finally {
      fs.unlinkSync(legacyFile);
    }
  });

  test('rejects an altered draft window even when the reviewer refreshes its hash', async () => {
    const alteredId = 'action-12345678-1234-1234-1234-123456789abe';
    const alteredFile = path.join(actionDir, `${alteredId}.json`);
    fs.writeFileSync(
      alteredFile,
      JSON.stringify({
        ...draft,
        action_id: alteredId,
        evidence_window: { start_date: '2026-09-02', end_date: '2026-09-07' },
      }),
    );
    try {
      const list = await routes.request(
        `/${encodeURIComponent(jid)}/ecommerce-actions`,
      );
      const { actions } = await list.json();
      const item = actions.find(
        (entry: { draft: { action_id: string } }) =>
          entry.draft.action_id === alteredId,
      );
      const decision = await routes.request(
        `/${encodeURIComponent(jid)}/ecommerce-actions/${alteredId}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'approved',
            reason: 'Window looks altered',
            draft_hash: item.draft_hash,
          }),
        },
      );
      expect(decision.status).toBe(409);
    } finally {
      fs.unlinkSync(alteredFile);
    }
  });

  test('owner sees a draft; another user cannot inspect or decide', async () => {
    const visible = await routes.request(
      `/${encodeURIComponent(jid)}/ecommerce-actions`,
    );
    expect(visible.status).toBe(200);
    expect((await visible.json()).actions).toHaveLength(1);

    const hidden = await routes.request(
      `/${encodeURIComponent(jid)}/ecommerce-actions`,
      {
        headers: { 'x-user': 'stranger' },
      },
    );
    expect(hidden.status).toBe(404);
  });

  test('requires the hash seen by the reviewer and records a single decision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T09:00:00Z'));
    const list = await routes.request(
      `/${encodeURIComponent(jid)}/ecommerce-actions`,
    );
    const { actions } = await list.json();
    const endpoint = `/${encodeURIComponent(jid)}/ecommerce-actions/${actionId}/decision`;
    const stale = await routes.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'approved',
        reason: 'Checked',
        draft_hash: '0'.repeat(64),
      }),
    });
    expect(stale.status).toBe(409);

    const forbidden = await routes.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user': 'stranger' },
      body: JSON.stringify({
        decision: 'approved',
        reason: 'Checked',
        draft_hash: actions[0].draft_hash,
      }),
    });
    expect(forbidden.status).toBe(404);

    const accepted = await routes.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'approved',
        reason: 'Checked',
        draft_hash: actions[0].draft_hash,
      }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).review.decision).toBe('approved');
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));

    const manualEndpoint = `/${encodeURIComponent(jid)}/ecommerce-actions/${actionId}/manual-execution`;
    const manualBody = {
      draft_hash: actions[0].draft_hash,
      occurred_at: '2026-09-08T10:00:00Z',
      external_reference: 'seller-console-123',
      note: 'Adjusted the budget manually',
    };
    expect(
      (
        await routes.request(manualEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...manualBody,
            occurred_at: '2026-09-08T08:00:00Z',
          }),
        })
      ).status,
    ).toBe(409);
    const unauthorizedManual = await routes.request(manualEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user': 'stranger' },
      body: JSON.stringify(manualBody),
    });
    expect(unauthorizedManual.status).toBe(404);
    const manual = await routes.request(manualEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manualBody),
    });
    expect(manual.status).toBe(200);
    expect((await manual.json()).manual_execution.external_reference).toBe(
      'seller-console-123',
    );
    expect(
      (
        await routes.request(manualEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(manualBody),
        })
      ).status,
    ).toBe(409);

    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));

    const outcomeEndpoint = `/${encodeURIComponent(jid)}/ecommerce-actions/${actionId}/outcome-review`;
    const before = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    };
    const after = {
      skuId: 'SKU-LOW',
      site: 'US',
      startDate: '2026-09-09',
      endDate: '2026-09-15',
    };
    const result = ecommerce.reviewEcommerceWindows(
      ecommerce.loadEcommerceDataset(dataDir),
      before,
      after,
    );
    expect(result.status).toBe('observed');
    const inconsistentTrace = ecommerce.recordEcommerceTrace(
      { dataDir },
      'ecommerce_review_windows',
      {
        ...result,
        delta: { ...result.delta, profit: result.delta.profit + 1 },
      },
    );
    expect(
      (
        await routes.request(outcomeEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draft_hash: actions[0].draft_hash,
            trace_id: inconsistentTrace.trace_id,
          }),
        })
      ).status,
    ).toBe(400);
    const trace = ecommerce.recordEcommerceTrace(
      { dataDir },
      'ecommerce_review_windows',
      result,
    );
    const outcomeBody = {
      draft_hash: actions[0].draft_hash,
      trace_id: trace.trace_id,
    };
    const costFile = path.join(dataDir, 'costs.csv');
    const originalCosts = fs.readFileSync(costFile, 'utf8');
    fs.appendFileSync(costFile, '\n');
    expect(
      (
        await routes.request(outcomeEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(outcomeBody),
        })
      ).status,
    ).toBe(409);
    fs.writeFileSync(costFile, originalCosts);
    const outcome = await routes.request(outcomeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outcomeBody),
    });
    expect(outcome.status).toBe(200);
    expect((await outcome.json()).outcome_review.result.status).toBe(
      'observed',
    );
    expect(
      (
        await routes.request(outcomeEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(outcomeBody),
        })
      ).status,
    ).toBe(409);

    const repeated = await routes.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'rejected',
        reason: 'Changed mind',
        draft_hash: actions[0].draft_hash,
      }),
    });
    expect(repeated.status).toBe(409);

    fs.writeFileSync(
      path.join(actionDir, `${actionId}.json`),
      JSON.stringify({ ...draft, proposed_value: 4 }),
    );
    const changed = await routes.request(
      `/${encodeURIComponent(jid)}/ecommerce-actions`,
    );
    expect((await changed.json()).actions[0].draft_changed_after_review).toBe(
      true,
    );
  });

  test('connects a real tool draft to human approval, manual record and review', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T09:00:00Z'));
    const tools = ecommerce.createEcommerceTools({
      dataDir,
      sessionId: 'tradepilot-integration-session',
      getPromptPlanHash: () => 'tradepilot-integration-plan',
    });
    const investigate = tools.find(
      (tool) => tool.name === 'ecommerce_investigate_sku',
    )!;
    const draftTool = tools.find(
      (tool) => tool.name === 'ecommerce_draft_action',
    )!;
    const reviewTool = tools.find(
      (tool) => tool.name === 'ecommerce_review_windows',
    )!;
    const investigation = await investigate.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        reference_time: '2026-09-08T09:00:00Z',
      },
      {},
    );
    expect(investigation.isError).not.toBe(true);
    const investigationTrace = JSON.parse(investigation.content[0].text).trace
      .trace_id as string;
    const drafted = await draftTool.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        action_type: 'adjust_ad_budget',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        unit: 'currency_per_day',
        currency: 'USD',
        reason: 'Policy-checked budget reduction',
        evidence_trace_ids: [investigationTrace],
        current_value: 37.5,
        proposed_value: 3,
      },
      {},
    );
    expect(drafted.isError).not.toBe(true);
    const generated = JSON.parse(drafted.content[0].text).data as {
      action_id: string;
      policy: { policy_status: string };
      executable: boolean;
    };
    expect(generated).toMatchObject({
      policy: { policy_status: 'allowed' },
      executable: false,
    });

    const listed = await routes.request(
      `/${encodeURIComponent(jid)}/ecommerce-actions`,
    );
    const { actions } = await listed.json();
    const item = actions.find(
      (entry: { draft: { action_id: string } }) =>
        entry.draft.action_id === generated.action_id,
    );
    expect(item).toBeDefined();
    const endpoint = `/${encodeURIComponent(jid)}/ecommerce-actions/${generated.action_id}`;
    const salesFile = path.join(dataDir, 'sales.csv');
    const originalSales = fs.readFileSync(salesFile, 'utf8');
    fs.appendFileSync(salesFile, '\n');
    try {
      const staleEvidence = await routes.request(`${endpoint}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'approved',
          reason: 'Must refresh evidence',
          draft_hash: item.draft_hash,
        }),
      });
      expect(staleEvidence.status).toBe(409);
    } finally {
      fs.writeFileSync(salesFile, originalSales);
    }
    const decision = await routes.request(`${endpoint}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'approved',
        reason: 'Reviewed evidence',
        draft_hash: item.draft_hash,
      }),
    });
    expect(decision.status).toBe(200);

    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    const manual = await routes.request(`${endpoint}/manual-execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft_hash: item.draft_hash,
        occurred_at: '2026-09-08T10:00:00Z',
        external_reference: 'manual-demo-reference',
        note: 'Test-only self-reported operation',
      }),
    });
    expect(manual.status).toBe(200);

    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    const review = await reviewTool.handler(
      {
        sku_id: 'SKU-LOW',
        site: 'US',
        before_start_date: '2026-09-01',
        before_end_date: '2026-09-07',
        after_start_date: '2026-09-09',
        after_end_date: '2026-09-15',
      },
      {},
    );
    expect(review.isError).not.toBe(true);
    const reviewTrace = JSON.parse(review.content[0].text).trace
      .trace_id as string;
    const outcome = await routes.request(`${endpoint}/outcome-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft_hash: item.draft_hash,
        trace_id: reviewTrace,
      }),
    });
    expect(outcome.status).toBe(200);
    expect((await outcome.json()).outcome_review.result.status).toBe(
      'observed',
    );
  });
});
