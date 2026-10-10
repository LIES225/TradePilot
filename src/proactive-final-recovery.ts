import type {
  ActiveTurnOutputRegistry,
  ProactiveFinalRecoveryDecision,
} from './turn-output-coordinator.js';
import type { MessageFinalizationReason } from './types.js';

export interface ProactiveFinalFallbackDelivery {
  /** The canonical Web session contains the recovered final answer. */
  projected: boolean;
  /** The native target, when present, physically ACKed the recovered answer. */
  targetDelivered: boolean;
  path: 'native' | 'web' | 'web_after_native_failure';
}

export interface ProactiveFinalRecoveryResult {
  attempted: boolean;
  projected: boolean;
  targetDelivered: boolean;
  path?: ProactiveFinalFallbackDelivery['path'];
  reason:
    | ProactiveFinalRecoveryDecision['reason']
    | 'incomplete_turn'
    | 'reply_limit_reached';
}

export interface UnacknowledgedProactiveFinalProjectionResult {
  projected: boolean;
  finalizationReason: Extract<
    MessageFinalizationReason,
    'delivery_uncertain' | 'error'
  >;
}

/**
 * Preserve the exact explicit final in the canonical Web session when native
 * delivery was not acknowledged.
 *
 * This never retries the provider mutation and deliberately records only a
 * projection, so native delivery accounting and retry fences remain intact.
 */
export async function preserveUnacknowledgedProactiveFinal(input: {
  registry: ActiveTurnOutputRegistry;
  scopeKey: string;
  inputTurnId: string;
  text: string;
  uncertain: boolean;
  project: (
    text: string,
    finalizationReason: Extract<
      MessageFinalizationReason,
      'delivery_uncertain' | 'error'
    >,
  ) => Promise<boolean>;
}): Promise<UnacknowledgedProactiveFinalProjectionResult> {
  const finalizationReason = input.uncertain ? 'delivery_uncertain' : 'error';
  const projected = await input.project(input.text, finalizationReason);
  if (projected) {
    input.registry.recordProjectedUtterance({
      scopeKey: input.scopeKey,
      inputTurnId: input.inputTurnId,
      role: 'final',
      text: input.text,
    });
  }
  return { projected, finalizationReason };
}

/**
 * Recover hidden SDK final text without duplicating an acknowledged Proactive
 * final message.
 *
 * The registry is the process-local view of user-visible projections. Native
 * physical acknowledgement remains a distinct result so a Web recovery cannot
 * accidentally settle provider-delivery accounting.
 */
export async function recoverProactiveFinalCandidate(input: {
  registry: ActiveTurnOutputRegistry;
  scopeKey: string;
  inputTurnId: string;
  inputTurnCompleted: boolean | undefined;
  candidate: string | null | undefined;
  canDeliver: () => boolean;
  deliver: (text: string) => Promise<ProactiveFinalFallbackDelivery>;
}): Promise<ProactiveFinalRecoveryResult> {
  if (!input.inputTurnCompleted) {
    return {
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: 'incomplete_turn',
    };
  }
  const decision = input.registry.resolveProactiveFinalRecovery({
    scopeKey: input.scopeKey,
    inputTurnId: input.inputTurnId,
    text: input.candidate,
  });
  if (!decision.deliver || !decision.text) {
    return {
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: decision.reason,
    };
  }
  if (!input.canDeliver()) {
    return {
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: 'reply_limit_reached',
    };
  }

  const delivery = await input.deliver(decision.text);
  if (delivery.projected) {
    input.registry.recordProjectedUtterance({
      scopeKey: input.scopeKey,
      inputTurnId: input.inputTurnId,
      role: 'final',
      text: decision.text,
    });
  }
  return {
    attempted: true,
    projected: delivery.projected,
    targetDelivered: delivery.targetDelivered,
    path: delivery.path,
    reason: decision.reason,
  };
}
