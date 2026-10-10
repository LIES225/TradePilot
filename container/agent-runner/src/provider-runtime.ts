export const CLAUDE_ENDPOINT_KIND_ENV = 'MINICLAW_CLAUDE_ENDPOINT_KIND';
export const MINICLAW_CLAUDE_ENDPOINT_KIND_ENV =
  'MINICLAW_CLAUDE_ENDPOINT_KIND';

export type ClaudeEndpointKind = 'official' | 'custom';

export interface ClaudeProviderRuntime {
  endpointKind: ClaudeEndpointKind;
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
  missingRequiredModel: boolean;
}

export interface ClaudeQueryModelRuntime {
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
}

/** Resolve a model at query time so a warm runner can switch tiers without respawn. */
export function resolveClaudeQueryModelRuntime(
  providerRuntime: ClaudeProviderRuntime,
  modelOverride?: string,
): ClaudeQueryModelRuntime {
  const model = modelOverride?.trim() || providerRuntime.model;
  return {
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
  };
}

/**
 * Resolve the provider/model contract once at runner startup.
 *
 * New hosts inject an authoritative endpoint-kind marker. Falling back to
 * ANTHROPIC_BASE_URL keeps the runner compatible with older hosts and images.
 */
export function resolveClaudeProviderRuntime(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeProviderRuntime {
  const model = env.ANTHROPIC_MODEL?.trim() ?? '';
  const marker = (
    env[MINICLAW_CLAUDE_ENDPOINT_KIND_ENV] || env[CLAUDE_ENDPOINT_KIND_ENV]
  )
    ?.trim()
    .toLowerCase();
  const endpointKind: ClaudeEndpointKind =
    marker === 'official' || marker === 'custom'
      ? marker
      : env.ANTHROPIC_BASE_URL?.trim()
        ? 'custom'
        : 'official';

  return {
    endpointKind,
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
    missingRequiredModel: endpointKind === 'custom' && !model,
  };
}
