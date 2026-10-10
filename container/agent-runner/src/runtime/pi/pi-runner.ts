import type {
  ContainerInput,
  ContainerOutput,
  ImageMediaType,
  StreamEvent,
} from '../../types.js';
import type { McpContext } from '../../mcp-tools.js';
import {
  IpcTurnDeliveryTracker,
  type IpcDeliveryReceipt,
  type IpcInputMessage,
} from '../../ipc-delivery.js';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeInput,
  RuntimeResult,
  RuntimeSession,
} from '../types.js';

type PiQueryRunResult = {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  cancelledIpcReceipts?: IpcDeliveryReceipt[];
  pipedMessagesDuringQuery: IpcInputMessage[];
  durableInputTurnCompleted?: boolean;
};

type PiQueryRunOptions = {
  runtime: AgentRuntime;
  sessionOptions: Parameters<AgentRuntime['createSession']>[0];
  prompt: string;
  images?: Array<{ data: string; mimeType?: string }>;
  containerInput: ContainerInput;
  tracker: IpcTurnDeliveryTracker;
  emit: (output: ContainerOutput) => void;
  log: (message: string) => void;
  drainInput: () => IpcInputMessage[];
  shouldClose: () => boolean;
  shouldInterrupt: () => boolean;
  acceptIpcMessagesDuringQuery: boolean;
  onSessionId: (sessionId: string) => void;
  onTurnActivated: (messages: IpcInputMessage[]) => void;
  onTurnCompleted: () => void;
  sourceKindOverride?: ContainerOutput['sourceKind'];
};

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toRuntimeInput(
  text: string,
  images?: Array<{ data: string; mimeType?: string }>,
): RuntimeInput {
  return {
    text,
    images: images?.map((image) => ({
      data: image.data,
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    })),
  };
}

function toStreamEvent(
  event: RuntimeEvent,
  containerInput: ContainerInput,
): StreamEvent | undefined {
  switch (event.type) {
    case 'text_delta':
      return {
        eventType: 'text_delta',
        agentScope: 'main',
        displayLevel: 'primary',
        text: event.delta,
        sessionId: event.sessionId,
      };
    case 'thinking_delta':
      return {
        eventType: 'thinking_delta',
        agentScope: 'main',
        displayLevel: 'detail',
        text: event.delta,
        sessionId: event.sessionId,
      };
    case 'tool_start':
      return {
        eventType: 'tool_use_start',
        agentScope: event.toolName.startsWith('mcp__') ? 'main' : 'main',
        displayLevel: 'detail',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolInput:
          event.input && typeof event.input === 'object'
            ? (event.input as Record<string, unknown>)
            : undefined,
        sessionId: event.sessionId,
      };
    case 'tool_update':
      return {
        eventType: 'tool_progress',
        agentScope: 'main',
        displayLevel: 'detail',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        detail:
          event.result === undefined ? undefined : stringify(event.result),
        sessionId: event.sessionId,
      };
    case 'tool_end':
      return {
        eventType: 'tool_use_end',
        agentScope: 'main',
        displayLevel: 'detail',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolResult:
          event.result === undefined ? undefined : stringify(event.result),
        sessionId: event.sessionId,
      };
    case 'usage':
      return {
        eventType: 'usage',
        agentScope: 'main',
        displayLevel: 'detail',
        usage: {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadInputTokens: event.usage.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: event.usage.cacheCreationInputTokens ?? 0,
          reasoningTokens: event.usage.reasoningTokens ?? 0,
          costUSD: event.usage.costUSD ?? 0,
          durationMs: event.usage.durationMs ?? 0,
          numTurns: event.usage.numTurns ?? 0,
        },
        sessionId: event.sessionId,
      };
    case 'status':
      return {
        eventType: 'status',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: event.statusText,
        sessionId: event.sessionId,
      };
    case 'compaction_start':
      return {
        eventType: 'compact_boundary',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: 'compaction_start',
        detail: event.reason,
        sessionId: event.sessionId,
      };
    case 'compaction_end':
      return {
        eventType: 'compact_boundary',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: event.error ? 'compaction_error' : 'compaction_end',
        detail: event.error || event.reason,
        sessionId: event.sessionId,
      };
    case 'subagent':
      return {
        eventType: 'task_progress',
        agentScope: 'subagent',
        displayLevel: 'detail',
        taskId: event.agentId,
        taskStatus: event.lifecycle,
        taskSummary: event.result || event.error,
        rawEvent:
          event.details && typeof event.details === 'object'
            ? (event.details as Record<string, unknown>)
            : undefined,
        sessionId: event.sessionId,
      };
    case 'session':
      return {
        eventType: 'status',
        agentScope: 'system',
        displayLevel: 'debug',
        statusText: `session:${event.sessionId}`,
        sessionId: event.sessionId,
      };
    case 'error':
      return {
        eventType: 'status',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: event.error,
        sessionId: event.sessionId,
      };
    case 'result':
      return undefined;
  }
}

function emitRuntimeEvent(
  event: RuntimeEvent,
  options: PiQueryRunOptions,
  resultState: { result?: RuntimeResult; fatalError?: string },
): void {
  if (event.type === 'result') {
    resultState.result = event.result;
    return;
  }
  if (event.type === 'error') {
    if (event.fatal) resultState.fatalError = event.error;
  }
  const streamEvent = toStreamEvent(event, options.containerInput);
  if (streamEvent) {
    options.emit({ status: 'stream', result: null, streamEvent });
  }
}

/**
 * Execute one Pi turn behind the existing ContainerOutput/IPC boundary.
 * The host-facing loop remains unchanged; this function is the compatibility
 * seam that lets Pi stream, queue, abort, persist and report a turn using the
 * runner's existing durable delivery semantics.
 */
export async function runPiQueryAttempt(
  options: PiQueryRunOptions,
): Promise<PiQueryRunResult> {
  const session = await options.runtime.createSession(options.sessionOptions);
  options.onSessionId(session.sessionId);
  const resultState: { result?: RuntimeResult; fatalError?: string } = {};
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  let cancelledIpcReceipts: IpcDeliveryReceipt[] = [];
  let completionPublished = false;
  let promptError: unknown;

  const unsubscribe = session.subscribe((event) =>
    emitRuntimeEvent(event, options, resultState),
  );

  const publishResult = (result: RuntimeResult): void => {
    if (completionPublished) return;
    completionPublished = true;
    const receipts = options.tracker.completeNextTurn();
    const inputTurnCompleted = result.finalizationReason === 'completed';
    options.emit({
      status: inputTurnCompleted ? 'success' : 'error',
      result: result.text || null,
      newSessionId: result.sessionId,
      sourceKind: options.sourceKindOverride ?? 'sdk_final',
      finalizationReason: result.finalizationReason,
      inputTurnCompleted,
      queryIdle: !options.tracker.hasPendingTurns,
      ...(receipts.length > 0 ? { ipcReceipts: receipts } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    if (inputTurnCompleted) {
      options.onTurnCompleted();
      if (options.tracker.hasPendingTurns) {
        completionPublished = false;
        options.onTurnActivated(options.tracker.currentTurnMessages);
      }
    }
  };

  try {
    const promptPromise = session.prompt(
      toRuntimeInput(options.prompt, options.images),
    );
    let promptDone = false;
    promptPromise.then(
      () => {
        promptDone = true;
      },
      (error) => {
        promptDone = true;
        promptError = error;
      },
    );

    while (true) {
      if (options.shouldClose()) {
        closedDuringQuery = true;
        await session.abort().catch(() => undefined);
        break;
      }
      if (options.shouldInterrupt()) {
        interruptedDuringQuery = true;
        const cancelled = options.tracker.cancelCurrentTurn();
        cancelledIpcReceipts = cancelled
          .map((message) => message.receipt)
          .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
        await session.abort().catch(() => undefined);
        break;
      }

      if (options.acceptIpcMessagesDuringQuery) {
        const messages = options.drainInput();
        for (const message of messages) {
          options.tracker.acceptTurn([message]);
          await session.followUp(toRuntimeInput(message.text, message.images));
        }
      }

      if (resultState.result) {
        const result = resultState.result;
        resultState.result = undefined;
        publishResult(result);
      }
      if (resultState.fatalError) {
        throw new Error(resultState.fatalError);
      }
      // AgentSession.prompt() can reject before Pi emits an agent_end event
      // (for example, when credentials are missing). Surface that provider
      // error before the generic queue invariant below so the host can retry
      // or quarantine the provider with the actual cause.
      if (promptDone && promptError) {
        throw promptError;
      }
      if (promptDone && !options.tracker.hasPendingTurns) break;
      if (promptDone && !session.isStreaming && !resultState.result) {
        if (!options.tracker.hasPendingTurns) break;
        throw new Error('Pi session ended with uncompleted input turns');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await promptPromise.catch(() => undefined);
    if (promptError && !interruptedDuringQuery && !closedDuringQuery) {
      throw promptError;
    }
    if (!closedDuringQuery && !interruptedDuringQuery && resultState.result) {
      publishResult(resultState.result);
    }
  } finally {
    unsubscribe();
    session.dispose();
  }

  return {
    newSessionId: session.sessionId,
    closedDuringQuery,
    interruptedDuringQuery,
    ...(cancelledIpcReceipts.length > 0 ? { cancelledIpcReceipts } : {}),
    pipedMessagesDuringQuery: options.tracker.unacknowledgedMessages,
    durableInputTurnCompleted: completionPublished && !interruptedDuringQuery,
  };
}
