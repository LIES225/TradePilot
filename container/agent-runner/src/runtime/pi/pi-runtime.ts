import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime,
  RuntimeSession,
  RuntimeSessionOptions,
} from '../types.js';
import { resolvePiProvider } from './pi-provider.js';
import { PiRuntimeSession } from './pi-session.js';

const require = createRequire(import.meta.url);

function existingPiSessionPath(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  if (!sessionId || !fs.existsSync(sessionDir)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  const candidate = fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .at(-1);
  return candidate ? path.join(sessionDir, candidate) : undefined;
}

function resolveSubagentsExtension(): string | undefined {
  try {
    const entry = require.resolve('@tintinweb/pi-subagents');
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

export class PiRuntimeAdapter implements AgentRuntime {
  readonly kind = 'pi' as const;

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const agentDir = path.join(options.sessionDir, '..', 'agent');
    fs.mkdirSync(options.sessionDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: true,
    });
    // Product auto-compact toggle: OFF disables the runtime-native compaction;
    // ON (or unset) keeps Pi's native threshold-based compaction behavior.
    settingsManager.setCompactionEnabled(options.autoCompactEnabled !== false);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const modelResolution = await resolvePiProvider(modelRuntime, {
      model: options.model,
      endpointKind: options.provider?.endpointKind,
      baseUrl: options.provider?.baseUrl,
      apiKey: options.provider?.apiKey,
    });

    const eventBus = createEventBus();
    const extensionPaths = [...(options.extensionPaths ?? [])];
    const subagentsExtension = resolveSubagentsExtension();
    if (subagentsExtension && !extensionPaths.includes(subagentsExtension)) {
      extensionPaths.push(subagentsExtension);
    }
    let resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      eventBus,
      systemPrompt: options.systemPrompt,
      additionalSkillPaths: options.skillPaths,
      additionalExtensionPaths: extensionPaths,
    });
    try {
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
    } catch (error) {
      // Pi remains usable when an optional extension is missing, malformed, or
      // incompatible. Do not silently downgrade to Claude; retrying without
      // only the optional subagent extension keeps the selected runtime
      // explicit and lets the regular tools fail visibly if requested.
      if (!subagentsExtension || !extensionPaths.includes(subagentsExtension)) {
        throw error;
      }
      const withoutSubagents = extensionPaths.filter(
        (entry) => entry !== subagentsExtension,
      );
      resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        eventBus,
        systemPrompt: options.systemPrompt,
        additionalSkillPaths: options.skillPaths,
        additionalExtensionPaths: withoutSubagents,
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
    }

    const sessionFile = existingPiSessionPath(
      options.sessionDir,
      options.sessionId || '',
    );
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, options.sessionDir, options.cwd)
      : SessionManager.create(options.cwd, options.sessionDir, {
          ...(options.sessionId ? { id: options.sessionId } : {}),
        });
    const customTools = (options.customTools ?? []) as ToolDefinition[];
    const toolAliases: Record<string, string> = {
      Bash: 'bash',
      Read: 'read',
      Write: 'write',
      Edit: 'edit',
      Glob: 'find',
      Grep: 'grep',
      Task: 'Agent',
      TaskOutput: 'get_subagent_result',
      TaskStop: 'steer_subagent',
    };
    const allowedNames = options.allowedTools ?? [];
    const selectedTools = options.allowedTools
      ? [
          ...new Set(
            allowedNames.flatMap((name) => {
              if (name === 'mcp__miniclaw__*') {
                return customTools.map((tool) => tool.name);
              }
              return [toolAliases[name] || name];
            }),
          ),
        ].filter(
          (name) =>
            ['read', 'bash', 'edit', 'write', 'find', 'grep', 'ls'].includes(
              name,
            ) ||
            customTools.some((tool) => tool.name === name) ||
            ['Agent', 'get_subagent_result', 'steer_subagent'].includes(name),
        )
      : undefined;
    const excludedTools = options.excludedTools?.map(
      (name) => toolAliases[name] || name,
    );

    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      modelRuntime,
      model: modelResolution.model,
      thinkingLevel:
        options.thinkingLevel === 'off' ? 'minimal' : options.thinkingLevel,
      ...(selectedTools ? { tools: selectedTools } : {}),
      ...(excludedTools ? { excludeTools: excludedTools } : {}),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    return new PiRuntimeSession(session, eventBus);
  }
}
