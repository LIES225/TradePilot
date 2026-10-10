import { Hono, type Context } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  canModifyGroup,
  hasHostExecutionPermission,
  isHostExecutionGroup,
} from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { GROUPS_DIR } from '../config.js';
import {
  decideEcommerceAction,
  getEcommerceActionReview,
  getEcommerceManualExecution,
  getEcommerceOutcomeReview,
  hashEcommerceDraft,
  recordEcommerceManualExecution,
  recordEcommerceOutcomeReview,
} from '../ecommerce-approval-store.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  getAgentProfile,
  getRegisteredGroup,
  getWorkspaceAgentProfileId,
  getWorkspaceInteractionMode,
  listAgentChannelMountsByWorkspace,
  listWorkspaceRecords,
  listWorkspaceRuntimeSessionsByWorkspace,
  type AgentChannelMountRecord,
  type WorkspaceRecord,
} from '../db.js';
import { MiniclawOwnerProfileMutationSchema } from '../schemas.js';
import {
  clearMiniclawOwnerPreferredAddress,
  getMiniclawOwnerProfileProjection,
  OwnerProfileStoreError,
  setMiniclawOwnerPreferredAddress,
  skipMiniclawOwnerIntroduction,
} from '../owner-profile-store.js';

const workspaceRoutes = new Hono<{ Variables: Variables }>();

const ecommerceActionId = /^action-[0-9a-f-]{36}$/;
const ecommerceDraftSchema = z
  .object({
    action_id: z.string().regex(ecommerceActionId),
    sku_id: z.string().min(1),
    site: z.string().min(1),
    action_type: z.string().min(1),
    reason: z.string().min(1),
    evidence_trace_ids: z.array(z.string().min(1)).min(1),
    status: z.literal('approval_required'),
    executable: z.literal(false),
  })
  .passthrough();
const ecommerceDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(2000),
  draft_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
const ecommercePolicyVersions = {
  adjust_price: 'price-promotion-floor-v1',
  adjust_ad_budget: 'ad-budget-profit-guard-v1',
  replenish_inventory: 'inventory-seven-day-cover-v1',
  pause_listing: 'listing-pause-risk-v1',
} as const;
const ecommerceTimestampSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value)) &&
      Date.parse(value) <= Date.now() + 5 * 60_000,
  );
const ecommerceManualExecutionSchema = z.object({
  draft_hash: z.string().regex(/^[0-9a-f]{64}$/),
  occurred_at: ecommerceTimestampSchema,
  external_reference: z.string().trim().min(1).max(200),
  note: z.string().trim().min(1).max(2000),
});
const ecommerceOutcomeReviewSchema = z.object({
  draft_hash: z.string().regex(/^[0-9a-f]{64}$/),
  trace_id: z.string().regex(/^trace-[0-9a-f-]{36}$/),
});

const ecommerceDateSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  );

const ecommerceApprovalDraftSchema = z.object({
  action_type: z.enum([
    'adjust_price',
    'adjust_ad_budget',
    'replenish_inventory',
    'pause_listing',
  ]),
  unit: z.enum([
    'currency_per_unit',
    'currency_per_day',
    'units',
    'listing_state',
  ]),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  current_value: z.number().finite().nullable(),
  proposed_value: z.number().finite().nullable(),
  evidence_window: z.object({
    start_date: ecommerceDateSchema,
    end_date: ecommerceDateSchema,
  }),
  policy: z
    .object({
      policy_status: z.literal('allowed'),
      policy_version: z.string(),
    })
    .passthrough(),
});

const ecommerceReviewResultSchema = z
  .object({
    status: z.literal('observed'),
    comparison_days: z.number().int().min(1).max(366),
    sku_id: z.string().min(1),
    site: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    before: z.object({
      start_date: ecommerceDateSchema,
      end_date: ecommerceDateSchema,
      revenue: z.number().finite(),
      units: z.number().finite(),
      ad_spend: z.number().finite(),
      profit: z.number().finite(),
    }),
    after: z.object({
      start_date: ecommerceDateSchema,
      end_date: ecommerceDateSchema,
      revenue: z.number().finite(),
      units: z.number().finite(),
      ad_spend: z.number().finite(),
      profit: z.number().finite(),
    }),
    delta: z.object({
      revenue: z.number().finite(),
      units: z.number().finite(),
      ad_spend: z.number().finite(),
      profit: z.number().finite(),
    }),
  })
  .passthrough();

function currentEcommerceDatasetHash(dataDir: string): string {
  const hash = crypto.createHash('sha256');
  for (const filename of [
    'products.csv',
    'sales.csv',
    'inventory.csv',
    'ads.csv',
    'promotions.csv',
    'costs.csv',
  ]) {
    hash.update(filename);
    hash.update(fs.readFileSync(path.join(dataDir, filename)));
  }
  return hash.digest('hex');
}

function hasMatchingEcommerceInvestigation(
  workspaceRoot: string,
  dataDir: string,
  scope: {
    sku_id: string;
    site: string;
    evidence_trace_ids: string[];
    start_date: string;
    end_date: string;
  },
): boolean {
  if (scope.start_date > scope.end_date) return false;
  try {
    const datasetHash = currentEcommerceDatasetHash(dataDir);
    const traceFile = path.join(dataDir, '.traces', 'tool-traces.jsonl');
    const stat = fs.lstatSync(traceFile);
    const realFile = fs.realpathSync(traceFile);
    if (
      !stat.isFile() ||
      stat.size > 5 * 1024 * 1024 ||
      !realFile.startsWith(`${workspaceRoot}${path.sep}`)
    )
      return false;
    const traces = fs
      .readFileSync(traceFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const selected = scope.evidence_trace_ids.map((id) =>
      traces.filter((trace) => trace.trace_id === id),
    );
    if (selected.some((matches) => matches.length !== 1)) return false;
    const records = selected.map((matches) => matches[0]);
    return (
      records.every(
        (trace) =>
          trace.sku_id === scope.sku_id &&
          trace.site === scope.site &&
          trace.start_date === scope.start_date &&
          trace.end_date === scope.end_date &&
          trace.dataset_hash === datasetHash,
      ) &&
      records.some(
        (trace) =>
          trace.tool === 'ecommerce_investigate_sku' &&
          trace.status === 'ready_for_recommendation',
      )
    );
  } catch {
    return false;
  }
}

function readEcommerceDraft(folder: string, actionId: string) {
  if (!ecommerceActionId.test(actionId)) return null;
  const root = path.resolve(GROUPS_DIR);
  const workspaceRoot = path.resolve(root, folder);
  if (!workspaceRoot.startsWith(`${root}${path.sep}`)) return null;
  const file = path.join(
    workspaceRoot,
    'ecommerce-data',
    '.actions',
    `${actionId}.json`,
  );
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const realFile = fs.realpathSync(file);
    if (!realFile.startsWith(`${workspaceRoot}${path.sep}`)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = ecommerceDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.action_id !== actionId) return null;
    return { draft: parsed.data, hash: hashEcommerceDraft(raw) };
  } catch {
    return null;
  }
}

type ResolvedWorkspaceAccess = {
  workspace: WorkspaceRecord;
  group: RegisteredGroup & { jid: string };
};

function resolveWorkspaceAccess(
  user: AuthUser,
  workspace: WorkspaceRecord,
): ResolvedWorkspaceAccess | null {
  const group = getRegisteredGroup(workspace.jid);
  if (!group || !workspace.jid.startsWith('web:')) return null;

  const groupWithJid = { ...group, jid: workspace.jid };
  const isAdmin = hasHostExecutionPermission(user);
  if (
    isHostExecutionGroup(group) &&
    !isAdmin &&
    !(group.is_home && group.created_by === user.id)
  ) {
    return null;
  }

  if (!canAccessGroup(user, groupWithJid)) return null;
  return { workspace, group: groupWithJid };
}

function canInspectGovernance(
  user: AuthUser,
  access: ResolvedWorkspaceAccess,
): boolean {
  return hasHostExecutionPermission(user) || canModifyGroup(user, access.group);
}

function getAgentProfileSnapshot(
  workspace: WorkspaceRecord,
  includePolicy: boolean,
) {
  const profileId = getWorkspaceAgentProfileId(workspace.folder);
  if (!profileId) return null;
  const profile = getAgentProfile(profileId);
  if (!profile || profile.status !== 'active') return null;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    identity_hash: includePolicy ? profile.identity_hash : undefined,
    runtime_policy: includePolicy ? profile.runtime_policy : undefined,
    is_default: profile.is_default,
  };
}

function serializeMount(mount: AgentChannelMountRecord) {
  return {
    channel_jid: mount.channel_jid,
    channel_type: mount.channel_type,
    workspace_jid: mount.workspace_jid,
    workspace_folder: mount.workspace_folder,
    session_id: mount.session_id ?? null,
    routing_mode: mount.routing_mode,
    reply_policy: mount.reply_policy,
    activation_mode: mount.activation_mode,
    audience_mode: mount.audience_mode,
    owner_im_id: mount.owner_im_id ?? null,
    owner_user_id: mount.owner_user_id,
    agent_profile_id: mount.agent_profile_id,
    created_at: mount.created_at,
    updated_at: mount.updated_at,
  };
}

function serializeWorkspaceSummary(
  user: AuthUser,
  access: ResolvedWorkspaceAccess,
) {
  const { workspace, group } = access;
  const inspectGovernance = canInspectGovernance(user, access);
  const runtimeSessions = inspectGovernance
    ? listWorkspaceRuntimeSessionsByWorkspace(workspace.jid)
    : [];
  const channelMounts = inspectGovernance
    ? listAgentChannelMountsByWorkspace(workspace.jid)
    : [];
  const isAdmin = hasHostExecutionPermission(user);
  return {
    jid: workspace.jid,
    folder: workspace.folder,
    owner_user_id: inspectGovernance ? workspace.owner_user_id : undefined,
    name: workspace.name,
    status: workspace.status,
    is_home: workspace.is_home,
    execution_mode: inspectGovernance
      ? (group.executionMode ?? 'container')
      : undefined,
    interaction_mode: getWorkspaceInteractionMode(workspace.folder),
    custom_cwd: isAdmin ? (group.customCwd ?? null) : undefined,
    agent_profile: getAgentProfileSnapshot(workspace, inspectGovernance),
    runtime_session_count: inspectGovernance
      ? runtimeSessions.length
      : undefined,
    channel_mount_count: inspectGovernance ? channelMounts.length : undefined,
    can_modify: canModifyGroup(user, group),
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

function listVisibleWorkspaces(user: AuthUser): ResolvedWorkspaceAccess[] {
  return listWorkspaceRecords()
    .map((workspace) => resolveWorkspaceAccess(user, workspace))
    .filter((access): access is ResolvedWorkspaceAccess => access !== null);
}

function resolveOwnerProfileAccess(
  user: AuthUser,
  jid: string,
): ResolvedWorkspaceAccess | null {
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace || !workspace.is_home || workspace.owner_user_id !== user.id) {
    return null;
  }
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access || access.group.created_by !== user.id) return null;
  const profile = getAgentProfileSnapshot(workspace, true);
  return profile?.is_default === true ? access : null;
}

function ownerProfileError(c: Context, error: unknown): Response {
  if (error instanceof OwnerProfileStoreError) {
    if (error.code === 'revision_conflict') {
      return c.json(
        {
          error: error.code,
          message: error.message,
          currentRevision: error.details?.currentRevision,
          storeRevision: error.details?.storeRevision,
        },
        409,
      );
    }
    if (error.code === 'idempotency_conflict') {
      return c.json({ error: error.code, message: error.message }, 409);
    }
    if (error.code === 'not_home_workspace') {
      return c.json({ error: 'Owner Profile not found' }, 404);
    }
    return c.json({ error: error.code, message: error.message }, 400);
  }
  return c.json({ error: 'Owner Profile request failed' }, 500);
}

workspaceRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaces = listVisibleWorkspaces(user).map((access) =>
    serializeWorkspaceSummary(user, access),
  );
  return c.json({ workspaces });
});

workspaceRoutes.get('/mounts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const channelMounts = listVisibleWorkspaces(user)
    .filter((access) => canInspectGovernance(user, access))
    .flatMap((access) =>
      listAgentChannelMountsByWorkspace(access.workspace.jid).map(
        serializeMount,
      ),
    );
  return c.json({ channel_mounts: channelMounts });
});

workspaceRoutes.get('/:jid/owner-profile', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const access = resolveOwnerProfileAccess(user, c.req.param('jid'));
  if (!access) return c.json({ error: 'Owner Profile not found' }, 404);
  try {
    return c.json({
      profile: getMiniclawOwnerProfileProjection(access.workspace.jid),
    });
  } catch (error) {
    return ownerProfileError(c, error);
  }
});

workspaceRoutes.patch('/:jid/owner-profile', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const access = resolveOwnerProfileAccess(user, c.req.param('jid'));
  if (!access) return c.json({ error: 'Owner Profile not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = MiniclawOwnerProfileMutationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', details: parsed.error.format() },
      400,
    );
  }
  const context = {
    actorId: user.id,
    sourceType: 'web_user' as const,
    sourceId: `api:${access.workspace.jid}:owner-profile`,
    observedAt: new Date().toISOString(),
  };
  try {
    switch (parsed.data.action) {
      case 'set':
        return c.json(
          setMiniclawOwnerPreferredAddress({
            workspaceJid: access.workspace.jid,
            preferredAddress: parsed.data.preferredAddress,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
            context,
          }),
        );
      case 'clear':
        return c.json(
          clearMiniclawOwnerPreferredAddress({
            workspaceJid: access.workspace.jid,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
            context,
          }),
        );
      case 'skip':
        return c.json(
          skipMiniclawOwnerIntroduction({
            workspaceJid: access.workspace.jid,
            expectedOnboardingRevision: parsed.data.expectedOnboardingRevision,
            context,
          }),
        );
    }
  } catch (error) {
    return ownerProfileError(c, error);
  }
});

workspaceRoutes.get('/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) return c.json({ error: 'Workspace not found' }, 404);

  const inspectGovernance = canInspectGovernance(user, access);
  const runtimeSessions = inspectGovernance
    ? listWorkspaceRuntimeSessionsByWorkspace(workspace.jid).map((session) => ({
        group_folder: session.group_folder,
        runtime_agent_id: session.runtime_agent_id,
        workspace_jid: session.workspace_jid,
        sdk_session_id: session.sdk_session_id,
        provider_id: session.provider_id,
        agent_profile_id: session.agent_profile_id,
        agent_profile_version: session.agent_profile_version,
        identity_hash: session.identity_hash,
        created_at: session.created_at,
        updated_at: session.updated_at,
      }))
    : undefined;
  const channelMounts = inspectGovernance
    ? listAgentChannelMountsByWorkspace(workspace.jid).map(serializeMount)
    : undefined;

  return c.json({
    workspace: serializeWorkspaceSummary(user, access),
    runtime_sessions: runtimeSessions,
    channel_mounts: channelMounts,
  });
});

workspaceRoutes.get('/:jid/runtime-sessions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  if (!canInspectGovernance(user, access)) {
    return c.json(
      { error: 'Only the workspace owner can inspect runtime sessions' },
      403,
    );
  }
  return c.json({
    runtime_sessions: listWorkspaceRuntimeSessionsByWorkspace(jid),
  });
});

workspaceRoutes.get('/:jid/channel-mounts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  if (!canInspectGovernance(user, access)) {
    return c.json(
      { error: 'Only the workspace owner can inspect channel mounts' },
      403,
    );
  }
  const channelMounts =
    listAgentChannelMountsByWorkspace(jid).map(serializeMount);
  return c.json({ channel_mounts: channelMounts });
});

workspaceRoutes.get('/:jid/ecommerce-actions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspace = listWorkspaceRecords().find(
    (record) => record.jid === c.req.param('jid'),
  );
  const access = workspace && resolveWorkspaceAccess(user, workspace);
  if (!access) return c.json({ error: 'Workspace not found' }, 404);
  if (!canInspectGovernance(user, access))
    return c.json({ error: 'Forbidden' }, 403);

  const actionsDir = path.join(
    GROUPS_DIR,
    workspace.folder,
    'ecommerce-data',
    '.actions',
  );
  let actionIds: string[];
  try {
    actionIds = fs
      .readdirSync(actionsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((id) => ecommerceActionId.test(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return c.json({ actions: [] });
    return c.json({ error: 'Unable to read action drafts' }, 500);
  }

  const actions = actionIds.flatMap((id) => {
    const record = readEcommerceDraft(workspace.folder, id);
    if (!record) return [];
    const review = getEcommerceActionReview(workspace.jid, id);
    const manualExecution = getEcommerceManualExecution(workspace.jid, id);
    const outcomeReview = getEcommerceOutcomeReview(workspace.jid, id);
    return [
      {
        draft: record.draft,
        draft_hash: record.hash,
        review,
        manual_execution: manualExecution,
        outcome_review: outcomeReview,
        draft_changed_after_review:
          review !== null && review.draft_hash !== record.hash,
      },
    ];
  });
  return c.json({ actions });
});

workspaceRoutes.post(
  '/:jid/ecommerce-actions/:actionId/decision',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const workspace = listWorkspaceRecords().find(
      (record) => record.jid === c.req.param('jid'),
    );
    const access = workspace && resolveWorkspaceAccess(user, workspace);
    if (!access) return c.json({ error: 'Workspace not found' }, 404);
    if (!canInspectGovernance(user, access))
      return c.json({ error: 'Forbidden' }, 403);

    const body = ecommerceDecisionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success)
      return c.json({ error: 'Decision and reason are required' }, 400);
    const actionId = c.req.param('actionId');
    const record = readEcommerceDraft(workspace.folder, actionId);
    if (!record) return c.json({ error: 'Action draft not found' }, 404);
    if (record.hash !== body.data.draft_hash) {
      return c.json(
        { error: 'Action draft changed; refresh before deciding' },
        409,
      );
    }
    if (body.data.decision === 'approved') {
      const approvalDraft = ecommerceApprovalDraftSchema.safeParse(
        record.draft,
      );
      const expectedVersion = approvalDraft.success
        ? ecommercePolicyVersions[approvalDraft.data.action_type]
        : null;
      if (
        !approvalDraft.success ||
        approvalDraft.data.policy.policy_version !== expectedVersion
      ) {
        return c.json(
          { error: 'Action draft has no passing business policy' },
          409,
        );
      }
      const workspaceRoot = path.resolve(GROUPS_DIR, workspace.folder);
      const dataDir = path.join(workspaceRoot, 'ecommerce-data');
      if (
        !hasMatchingEcommerceInvestigation(workspaceRoot, dataDir, {
          sku_id: record.draft.sku_id,
          site: record.draft.site,
          evidence_trace_ids: record.draft.evidence_trace_ids,
          ...approvalDraft.data.evidence_window,
        })
      ) {
        return c.json({ error: 'Action evidence is missing or stale' }, 409);
      }
    }
    const review = decideEcommerceAction({
      workspaceJid: workspace.jid,
      actionId,
      draftHash: record.hash,
      decision: body.data.decision,
      reviewerUserId: user.id,
      reason: body.data.reason,
    });
    if (!review) return c.json({ error: 'Action already reviewed' }, 409);
    return c.json({ review });
  },
);

workspaceRoutes.post(
  '/:jid/ecommerce-actions/:actionId/manual-execution',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const workspace = listWorkspaceRecords().find(
      (item) => item.jid === c.req.param('jid'),
    );
    const access = workspace && resolveWorkspaceAccess(user, workspace);
    if (!access) return c.json({ error: 'Workspace not found' }, 404);
    if (!canInspectGovernance(user, access))
      return c.json({ error: 'Forbidden' }, 403);
    const parsed = ecommerceManualExecutionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: 'Invalid manual execution record' }, 400);
    const actionId = c.req.param('actionId');
    const record = readEcommerceDraft(workspace.folder, actionId);
    if (!record) return c.json({ error: 'Action draft not found' }, 404);
    if (record.hash !== parsed.data.draft_hash)
      return c.json(
        { error: 'Action draft changed; refresh before recording' },
        409,
      );
    const approval = getEcommerceActionReview(workspace.jid, actionId);
    if (
      approval?.decision !== 'approved' ||
      approval.draft_hash !== record.hash
    )
      return c.json({ error: 'A matching human approval is required' }, 409);
    if (Date.parse(parsed.data.occurred_at) < Date.parse(approval.reviewed_at))
      return c.json(
        { error: 'Manual execution must occur after approval' },
        409,
      );
    const execution = recordEcommerceManualExecution({
      workspaceJid: workspace.jid,
      actionId,
      draftHash: record.hash,
      operatorUserId: user.id,
      occurredAt: parsed.data.occurred_at,
      externalReference: parsed.data.external_reference,
      note: parsed.data.note,
    });
    if (!execution)
      return c.json({ error: 'Manual execution already recorded' }, 409);
    return c.json({ manual_execution: execution });
  },
);

workspaceRoutes.post(
  '/:jid/ecommerce-actions/:actionId/outcome-review',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const workspace = listWorkspaceRecords().find(
      (item) => item.jid === c.req.param('jid'),
    );
    const access = workspace && resolveWorkspaceAccess(user, workspace);
    if (!access) return c.json({ error: 'Workspace not found' }, 404);
    if (!canInspectGovernance(user, access))
      return c.json({ error: 'Forbidden' }, 403);
    const parsed = ecommerceOutcomeReviewSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: 'Invalid review Trace ID' }, 400);
    const actionId = c.req.param('actionId');
    const record = readEcommerceDraft(workspace.folder, actionId);
    if (!record) return c.json({ error: 'Action draft not found' }, 404);
    if (record.hash !== parsed.data.draft_hash)
      return c.json(
        { error: 'Action draft changed; refresh before reviewing' },
        409,
      );
    const execution = getEcommerceManualExecution(workspace.jid, actionId);
    if (!execution || execution.draft_hash !== record.hash)
      return c.json(
        { error: 'A matching manual execution record is required' },
        409,
      );
    const dataDir = path.join(GROUPS_DIR, workspace.folder, 'ecommerce-data');
    try {
      const datasetHash = currentEcommerceDatasetHash(dataDir);
      const traceFile = path.join(dataDir, '.traces', 'tool-traces.jsonl');
      const stat = fs.lstatSync(traceFile);
      const realFile = fs.realpathSync(traceFile);
      if (
        !stat.isFile() ||
        stat.size > 5 * 1024 * 1024 ||
        !realFile.startsWith(
          `${path.resolve(GROUPS_DIR, workspace.folder)}${path.sep}`,
        )
      )
        return c.json({ error: 'Review Trace is unavailable' }, 400);
      const trace = fs
        .readFileSync(traceFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.trace_id === parsed.data.trace_id);
      const result = ecommerceReviewResultSchema.safeParse(
        trace?.review_result,
      );
      if (
        !trace ||
        trace.tool !== 'ecommerce_review_windows' ||
        trace.dataset_hash !== datasetHash ||
        trace.status !== 'observed' ||
        trace.sku_id !== record.draft.sku_id ||
        trace.site !== record.draft.site ||
        typeof trace.created_at !== 'string' ||
        Date.parse(trace.created_at) < Date.parse(execution.recorded_at) ||
        !result.success ||
        result.data.sku_id !== record.draft.sku_id ||
        result.data.site !== record.draft.site
      )
        return c.json(
          {
            error: 'Review Trace does not match the current action and dataset',
          },
          409,
        );
      const executionDate = new Date(execution.occurred_at)
        .toISOString()
        .slice(0, 10);
      if (
        result.data.before.end_date >= executionDate ||
        result.data.after.start_date <= executionDate
      )
        return c.json(
          { error: 'Review windows must exclude the execution day' },
          400,
        );
      const dayCount = (start: string, end: string) =>
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
          86_400_000 +
        1;
      const beforeDays = dayCount(
        result.data.before.start_date,
        result.data.before.end_date,
      );
      const afterDays = dayCount(
        result.data.after.start_date,
        result.data.after.end_date,
      );
      if (
        beforeDays !== result.data.comparison_days ||
        afterDays !== beforeDays ||
        beforeDays < 1 ||
        beforeDays > 366 ||
        (['revenue', 'units', 'ad_spend', 'profit'] as const).some(
          (key) =>
            Math.abs(
              result.data.delta[key] -
                (result.data.after[key] - result.data.before[key]),
            ) > 1e-6,
        )
      )
        return c.json(
          { error: 'Review Trace has inconsistent windows or deltas' },
          400,
        );
      if (currentEcommerceDatasetHash(dataDir) !== datasetHash)
        return c.json({ error: 'Dataset changed during review; retry' }, 409);
      const review = recordEcommerceOutcomeReview({
        workspaceJid: workspace.jid,
        actionId,
        draftHash: record.hash,
        reviewerUserId: user.id,
        datasetHash,
        result: result.data,
      });
      if (!review)
        return c.json({ error: 'Outcome review already recorded' }, 409);
      return c.json({ outcome_review: review });
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      )
        return c.json({ error: 'Review Trace or dataset is unavailable' }, 400);
      return c.json({ error: 'Unable to review ecommerce dataset' }, 500);
    }
  },
);

export default workspaceRoutes;
