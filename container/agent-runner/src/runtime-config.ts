export type AgentRuntimeKind = 'claude' | 'pi';

export const AGENT_RUNTIME_ENV = 'AGENT_RUNTIME';
export const MINICLAW_AGENT_RUNTIME_ENV = 'MINICLAW_AGENT_RUNTIME';

/**
 * Resolve the runner engine. Pi is the product runtime; Claude is retained
 * only as an explicit compatibility selector while downstream deployments
 * finish their transcript migration.
 */
export function resolveAgentRuntimeKind(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentRuntimeKind {
  const configured = (env[MINICLAW_AGENT_RUNTIME_ENV] || env[AGENT_RUNTIME_ENV])
    ?.trim()
    .toLowerCase();
  if (!configured || configured === 'pi') return 'pi';
  if (configured === 'claude') return 'claude';
  if (configured === 'pi') return 'pi';
  throw new Error(
    `Unsupported ${AGENT_RUNTIME_ENV}=${configured}; expected claude or pi`,
  );
}
