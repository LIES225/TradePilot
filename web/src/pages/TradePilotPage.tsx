import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface WorkspaceSummary {
  jid: string;
  name: string;
  can_modify: boolean;
}

interface DecisionRecord {
  decision: 'approved' | 'rejected';
  reason: string;
  reviewed_at: string;
  reviewer_user_id: string;
}

interface ManualExecutionRecord {
  occurred_at: string;
  external_reference: string;
  note: string;
  operator_user_id: string;
}

interface OutcomeReviewRecord {
  reviewed_at: string;
  result: {
    status: string;
    currency: string;
    delta: { revenue: number; ad_spend: number; profit: number };
  };
}

interface ActionItem {
  draft_hash: string;
  draft: {
    action_id: string;
    sku_id: string;
    site: string;
    action_type: string;
    current_value?: number | null;
    proposed_value?: number | null;
    unit?: string;
    currency?: string | null;
    reason: string;
    evidence_trace_ids: string[];
  };
  review: DecisionRecord | null;
  manual_execution: ManualExecutionRecord | null;
  outcome_review: OutcomeReviewRecord | null;
  draft_changed_after_review: boolean;
}

interface ManualForm {
  occurredAt: string;
  externalReference: string;
  note: string;
}

const emptyManualForm: ManualForm = {
  occurredAt: '',
  externalReference: '',
  note: '',
};

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return '请求失败，请稍后重试';
}

export function TradePilotPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [jid, setJid] = useState('');
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [manualForms, setManualForms] = useState<Record<string, ManualForm>>(
    {},
  );
  const [reviewTraceIds, setReviewTraceIds] = useState<Record<string, string>>(
    {},
  );
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  function setManualField(
    actionId: string,
    field: keyof ManualForm,
    value: string,
  ) {
    setManualForms((current) => ({
      ...current,
      [actionId]: { ...(current[actionId] || emptyManualForm), [field]: value },
    }));
  }

  useEffect(() => {
    api
      .get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')
      .then(({ workspaces: rows }) => {
        const visible = rows.filter((row) => row.can_modify);
        setWorkspaces(visible);
        setJid((current) => current || visible[0]?.jid || '');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  async function loadActions(workspaceJid: string) {
    try {
      const result = await api.get<{ actions: ActionItem[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceJid)}/ecommerce-actions`,
      );
      setActions(result.actions);
      setError('');
    } catch (cause) {
      setActions([]);
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    if (jid) void loadActions(jid);
  }, [jid]);

  async function decide(
    actionId: string,
    draftHash: string,
    decision: 'approved' | 'rejected',
  ) {
    const reason = reasons[actionId]?.trim();
    if (!jid || !reason) {
      setError('请先填写审批理由');
      return;
    }
    setBusyId(actionId);
    try {
      await api.post(
        `/api/workspaces/${encodeURIComponent(jid)}/ecommerce-actions/${actionId}/decision`,
        { decision, reason, draft_hash: draftHash },
      );
      setReasons((current) => ({ ...current, [actionId]: '' }));
      await loadActions(jid);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId('');
    }
  }

  async function recordExecution(actionId: string, draftHash: string) {
    const form = manualForms[actionId];
    if (
      !jid ||
      !form?.occurredAt ||
      !form.externalReference.trim() ||
      !form.note.trim()
    ) {
      setError('请填写实际处置时间、外部凭据编号和处置说明');
      return;
    }
    setBusyId(actionId);
    try {
      await api.post(
        `/api/workspaces/${encodeURIComponent(jid)}/ecommerce-actions/${actionId}/manual-execution`,
        {
          draft_hash: draftHash,
          occurred_at: new Date(form.occurredAt).toISOString(),
          external_reference: form.externalReference.trim(),
          note: form.note.trim(),
        },
      );
      setManualForms((current) => ({
        ...current,
        [actionId]: emptyManualForm,
      }));
      await loadActions(jid);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId('');
    }
  }

  async function recordOutcome(actionId: string, draftHash: string) {
    const traceId = reviewTraceIds[actionId]?.trim();
    if (!jid || !traceId) {
      setError('请填写复核 Trace ID');
      return;
    }
    setBusyId(actionId);
    try {
      await api.post(
        `/api/workspaces/${encodeURIComponent(jid)}/ecommerce-actions/${actionId}/outcome-review`,
        { draft_hash: draftHash, trace_id: traceId },
      );
      setReviewTraceIds((current) => ({ ...current, [actionId]: '' }));
      await loadActions(jid);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId('');
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          TradePilot · Human Gate
        </p>
        <h1 className="mt-2 text-2xl font-semibold">经营决策审批</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          审批只记录人工决定，不会自动修改广告、价格、库存或商品状态。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-52 gap-1 text-sm">
          工作区
          <select
            className="rounded-lg border border-border bg-background px-3 py-2"
            value={jid}
            onChange={(event) => {
              setJid(event.target.value);
              setReasons({});
              setManualForms({});
              setReviewTraceIds({});
            }}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.jid} value={workspace.jid}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-lg border border-border px-3 py-2 text-sm"
          onClick={() => void loadActions(jid)}
          disabled={!jid}
        >
          刷新
        </button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {!jid ? (
        <p className="text-sm text-muted-foreground">没有可审批的工作区。</p>
      ) : null}
      {jid && actions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          暂无经营决策草案。先让 Agent 完成调查并调用 ecommerce_draft_action。
        </p>
      ) : null}

      <div className="space-y-4">
        {actions.map(
          ({
            draft,
            draft_hash,
            review,
            manual_execution,
            outcome_review,
            draft_changed_after_review,
          }) => (
            <article
              key={draft.action_id}
              className="rounded-xl border border-border bg-card p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">
                  {draft.sku_id} · {draft.site} · {draft.action_type}
                </h2>
                <span className="rounded-full bg-muted px-3 py-1 text-xs">
                  {review
                    ? review.decision === 'approved'
                      ? '已批准'
                      : '已拒绝'
                    : '待审批'}
                </span>
              </div>
              <p className="mt-3 text-sm">{draft.reason}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                当前：{draft.current_value ?? '—'} → 建议：
                {draft.proposed_value ?? '—'} {draft.unit || ''}{' '}
                {draft.currency || ''}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                证据 Trace：{draft.evidence_trace_ids.join(', ')}
              </p>
              {draft_changed_after_review ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  草案在审批后被修改；原审批不适用于当前内容。
                </p>
              ) : null}
              {review ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  审批理由：{review.reason} · {review.reviewed_at}
                </p>
              ) : (
                <div className="mt-4 space-y-3 border-t border-border pt-4">
                  <label className="grid gap-1 text-sm">
                    审批理由
                    <textarea
                      className="min-h-20 rounded-lg border border-border bg-background px-3 py-2"
                      maxLength={2000}
                      value={reasons[draft.action_id] || ''}
                      onChange={(event) =>
                        setReasons((current) => ({
                          ...current,
                          [draft.action_id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
                      disabled={Boolean(busyId)}
                      onClick={() =>
                        void decide(draft.action_id, draft_hash, 'approved')
                      }
                    >
                      批准草案
                    </button>
                    <button
                      className="rounded-lg border border-border px-4 py-2 text-sm"
                      disabled={Boolean(busyId)}
                      onClick={() =>
                        void decide(draft.action_id, draft_hash, 'rejected')
                      }
                    >
                      拒绝草案
                    </button>
                  </div>
                </div>
              )}
              {review?.decision === 'approved' &&
              !draft_changed_after_review ? (
                manual_execution ? (
                  <div className="mt-4 rounded-lg border border-border p-3 text-sm">
                    <p className="font-medium">
                      人工处置登记（操作人自述，非平台自动验证）
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {manual_execution.occurred_at} ·{' '}
                      {manual_execution.external_reference}
                    </p>
                    <p className="mt-1">{manual_execution.note}</p>
                  </div>
                ) : (
                  <div className="mt-4 space-y-2 border-t border-border pt-4">
                    <p className="text-sm font-medium">登记人工处置</p>
                    <input
                      aria-label="实际处置时间"
                      type="datetime-local"
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      value={manualForms[draft.action_id]?.occurredAt || ''}
                      onChange={(event) =>
                        setManualField(
                          draft.action_id,
                          'occurredAt',
                          event.target.value,
                        )
                      }
                    />
                    <input
                      aria-label="外部凭据编号"
                      placeholder="外部平台操作记录编号"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      maxLength={200}
                      value={
                        manualForms[draft.action_id]?.externalReference || ''
                      }
                      onChange={(event) =>
                        setManualField(
                          draft.action_id,
                          'externalReference',
                          event.target.value,
                        )
                      }
                    />
                    <textarea
                      aria-label="处置说明"
                      placeholder="写明实际操作和与批准草案的差异"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      maxLength={2000}
                      value={manualForms[draft.action_id]?.note || ''}
                      onChange={(event) =>
                        setManualField(
                          draft.action_id,
                          'note',
                          event.target.value,
                        )
                      }
                    />
                    <button
                      className="rounded-lg border border-border px-4 py-2 text-sm"
                      disabled={Boolean(busyId)}
                      onClick={() =>
                        void recordExecution(draft.action_id, draft_hash)
                      }
                    >
                      保存人工处置记录
                    </button>
                  </div>
                )
              ) : null}
              {manual_execution && !draft_changed_after_review ? (
                outcome_review ? (
                  <div className="mt-4 rounded-lg border border-border p-3 text-sm">
                    <p className="font-medium">
                      处置复核 · {outcome_review.result.status}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      利润差额 {outcome_review.result.delta.profit}{' '}
                      {outcome_review.result.currency}，广告花费差额{' '}
                      {outcome_review.result.delta.ad_spend}{' '}
                      {outcome_review.result.currency}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      仅为前后窗口观察差异，不证明人工处置实际发生或造成该变化。
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 space-y-2 border-t border-border pt-4">
                    <p className="text-sm font-medium">登记处置复核</p>
                    <p className="text-xs text-muted-foreground">
                      先让 Agent 调用
                      ecommerce_review_windows，使用处置日前后、同长度且不重叠的窗口；将返回的
                      Trace ID 填在这里。
                    </p>
                    <input
                      aria-label="复核 Trace ID"
                      placeholder="trace-..."
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      value={reviewTraceIds[draft.action_id] || ''}
                      onChange={(event) =>
                        setReviewTraceIds((current) => ({
                          ...current,
                          [draft.action_id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      className="rounded-lg border border-border px-4 py-2 text-sm"
                      disabled={Boolean(busyId)}
                      onClick={() =>
                        void recordOutcome(draft.action_id, draft_hash)
                      }
                    >
                      保存复核快照
                    </button>
                  </div>
                )
              ) : null}
            </article>
          ),
        )}
      </div>
    </main>
  );
}
