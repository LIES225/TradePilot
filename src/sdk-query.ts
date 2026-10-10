/**
 * Small Pi Agent Runtime wrapper for host-side structured helper queries.
 *
 * These calls are deliberately isolated from the long-lived container runner:
 * they use an in-memory Pi session, no tools, and the same provider settings
 * that the settings UI already manages. Claude remains an Anthropic provider,
 * not a Claude Agent SDK runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { getClaudeProviderConfig } from './runtime-config.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

function splitModelRef(value: string): { providerId: string; modelId: string } {
  const slash = value.indexOf('/');
  return slash > 0
    ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : { providerId: 'anthropic', modelId: value };
}

async function resolveModel(
  runtime: ModelRuntime,
  config: ReturnType<typeof getClaudeProviderConfig>,
  override?: string,
) {
  const modelRef = override?.trim() || config.anthropicModel.trim();
  const custom = !!config.anthropicBaseUrl.trim();
  if (custom) {
    if (!modelRef) throw new Error('Custom provider requires a model');
    const split = splitModelRef(modelRef);
    const providerId = `miniclaw-${split.providerId}`;
    runtime.registerProvider(providerId, {
      name: `Miniclaw ${split.providerId} compatible provider`,
      baseUrl: config.anthropicBaseUrl.trim(),
      api: 'anthropic-messages',
      ...(config.anthropicApiKey || config.anthropicAuthToken
        ? { apiKey: config.anthropicApiKey || config.anthropicAuthToken }
        : {}),
      models: [
        {
          id: split.modelId,
          name: split.modelId,
          api: 'anthropic-messages',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_000,
        },
      ],
    });
    return runtime.getModel(providerId, split.modelId);
  }

  if (config.anthropicApiKey || config.anthropicAuthToken) {
    await runtime.setRuntimeApiKey(
      'anthropic',
      config.anthropicApiKey || config.anthropicAuthToken,
    );
  }
  if (!modelRef) return runtime.getModels('anthropic')[0];
  const split = splitModelRef(modelRef);
  return runtime.getModel(split.providerId, split.modelId);
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('');
}

/** Send a no-tools prompt through Pi and return its plain-text answer. */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 60_000;
  const config = getClaudeProviderConfig();
  const agentDir = path.join(DATA_DIR, 'config', 'pi-agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const abortController = new AbortController();
  let activeSession: { abort: () => Promise<void> } | undefined;
  const timer = setTimeout(() => {
    abortController.abort();
    void activeSession?.abort();
  }, timeout);

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const model = await resolveModel(modelRuntime, config, opts?.model);
    if (!model) throw new Error('Pi could not resolve the configured model');

    const settingsManager = SettingsManager.create(process.cwd(), agentDir, {
      projectTrusted: true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      systemPrompt: '',
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      noTools: 'all',
      resourceLoader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
    });
    activeSession = session;

    let text = '';
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta') text += update.delta;
      }
      if (event.type === 'agent_end') {
        const assistant = [...event.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        const finalText = textFromMessage(assistant);
        if (finalText) text = finalText;
      }
    });
    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      session.dispose();
      activeSession = undefined;
    }
    return text.trim() || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'Pi helper query failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
