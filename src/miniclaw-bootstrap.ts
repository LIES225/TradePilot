export interface MiniclawBootstrapTurn {
  turnId?: string;
  isHome: boolean;
  isDefaultProfile: boolean;
  isScheduledTask?: boolean;
}

/**
 * Restrict the one-shot first-wake ritual to a real interactive turn of the
 * built-in Miniclaw in Home. Process warmups have no turnId; scheduled runs,
 * custom Agents, and non-Home workspaces are always excluded.
 */
export function isMiniclawBootstrapTurn(
  input: MiniclawBootstrapTurn,
): boolean {
  return Boolean(
    input.turnId &&
    input.isHome &&
    input.isDefaultProfile &&
    !input.isScheduledTask,
  );
}

export interface MiniclawOwnerProfileRuntime {
  isHome: boolean;
  isDefaultProfile: boolean;
  isScheduledTask?: boolean;
  runtimeAgentId?: string | null;
  runtimeAgentKind?: 'task' | 'conversation' | 'spawn' | null;
}

/**
 * Structural capability survives a turn-less terminal warmup so the same
 * runner can later serve an admitted owner turn. Per-turn data and mutations
 * remain host-authorized; scheduled/task/spawn runtimes never receive it.
 */
export function isMiniclawOwnerProfileRuntimeStructurallyEligible(
  input: MiniclawOwnerProfileRuntime,
): boolean {
  return Boolean(
    input.isHome &&
    input.isDefaultProfile &&
    !input.isScheduledTask &&
    (!input.runtimeAgentId || input.runtimeAgentKind === 'conversation'),
  );
}
