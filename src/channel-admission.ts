/**
 * Provider-neutral inbound admission contract.
 *
 * Pairing establishes ownership of an external chat and its default workspace.
 * Workspace/session routing happens later through resolveEffectiveChatJid; it
 * must never be consulted for an unpaired chat.
 */

export type ChannelAdmissionDecision =
  | { kind: 'allow' }
  | { kind: 'paired' }
  | { kind: 'pair_rejected' }
  | { kind: 'deny' };

export interface ChannelAdmissionInput {
  jid: string;
  chatName: string;
  text: string;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
}

export interface ChannelRouteTarget {
  effectiveJid: string;
  agentId: string | null;
  sourceJid?: string;
}

export function matchesChannelAccountAuthorization(input: {
  scopedAccountId?: string | null;
  groupOwnerUserId?: string | null;
  groupAccountId?: string | null;
  userId: string;
  expectedAccountId?: string;
  expectedAccountOwnerUserId?: string | null;
  expectedAccountIsLegacyDefault?: boolean;
  allowLegacyUnscoped?: boolean;
}): boolean {
  if (input.groupOwnerUserId !== input.userId) return false;
  if (input.expectedAccountId) {
    if (input.expectedAccountOwnerUserId !== input.userId) return false;
    if (input.groupAccountId !== input.expectedAccountId) return false;
    return input.scopedAccountId
      ? input.scopedAccountId === input.expectedAccountId
      : input.allowLegacyUnscoped === true;
  }
  if (input.scopedAccountId) return false;
  if (!input.groupAccountId) return true;
  return (
    input.expectedAccountOwnerUserId === input.userId &&
    input.expectedAccountIsLegacyDefault === true
  );
}

export function matchesChannelPairTarget(input: {
  scopedAccountId?: string | null;
  existingGroupAccountId?: string | null;
  expectedAccountId?: string;
  allowLegacyUnscoped?: boolean;
}): boolean {
  if (input.expectedAccountId) {
    if (input.scopedAccountId) {
      if (input.scopedAccountId !== input.expectedAccountId) return false;
    } else if (!input.allowLegacyUnscoped) {
      return false;
    }
  } else if (input.scopedAccountId) {
    return false;
  }
  return (
    !input.existingGroupAccountId ||
    input.existingGroupAccountId === input.expectedAccountId
  );
}

export class ChannelRouteRejectedError extends Error {
  readonly sourceJid: string;

  constructor(sourceJid: string) {
    super(`Channel binding resolver rejected route for ${sourceJid}`);
    this.name = 'ChannelRouteRejectedError';
    this.sourceJid = sourceJid;
  }
}

/** Parse the cross-channel `/pair <code>` command. */
export function parseChannelPairingCode(text: string): string | null {
  const match = text.trim().match(/^\/pair\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

/**
 * Decide whether an inbound message may enter the persistence/download/routing
 * pipeline. A pairing command is consumed here and never reaches the Agent.
 *
 * Channels without an authorization callback retain their legacy open behavior;
 * account-backed Discord/WhatsApp connectors always provide one.
 */
export async function evaluateChannelAdmission(
  input: ChannelAdmissionInput,
): Promise<ChannelAdmissionDecision> {
  const code = parseChannelPairingCode(input.text);
  if (code && input.onPairAttempt) {
    const paired = await input.onPairAttempt(input.jid, input.chatName, code);
    return { kind: paired ? 'paired' : 'pair_rejected' };
  }

  if (input.isChatAuthorized && !input.isChatAuthorized(input.jid)) {
    return { kind: 'deny' };
  }
  return { kind: 'allow' };
}

/**
 * A configured resolver owns routing authority. Its null means stale/invalid
 * binding and therefore fail-closed; only standalone connectors without a
 * resolver may persist directly under the source JID.
 */
export function resolveAdmittedChannelRoute<TContext = undefined>(
  sourceJid: string,
  resolver?: (jid: string, context?: TContext) => ChannelRouteTarget | null,
  context?: TContext,
): { targetJid: string; routing: ChannelRouteTarget | null } | null {
  if (!resolver) return { targetJid: sourceJid, routing: null };
  const routing = resolver(sourceJid, context);
  return routing ? { targetJid: routing.effectiveJid, routing } : null;
}
