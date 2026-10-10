import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeImage,
  RuntimeInput,
  RuntimeResult,
  RuntimeSession,
  RuntimeSessionOptions,
} from '../types.js';

type ClaudeQueryOptions = Record<string, unknown>;

type ClaudeImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function toClaudeImages(images: RuntimeImage[] | undefined): Array<{
  type: 'image';
  source: { type: 'base64'; media_type: ClaudeImageMediaType; data: string };
}> {
  return (images ?? []).map((image) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: (
        image.mimeType === 'image/png' ||
        image.mimeType === 'image/gif' ||
        image.mimeType === 'image/webp'
          ? image.mimeType
          : 'image/jpeg'
      ) as ClaudeImageMediaType,
      data: image.data,
    },
  }));
}

function toUserMessage(input: RuntimeInput, sessionId: string): SDKUserMessage {
  const images = toClaudeImages(input.images);
  return {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: images.length
        ? [{ type: 'text' as const, text: input.text }, ...images]
        : input.text,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

function textFromResult(message: Record<string, unknown>): string {
  const result = message.result;
  if (typeof result === 'string') return result;
  const content = (message.message as Record<string, unknown> | undefined)
    ?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function mapClaudeMessage(message: SDKMessage, sessionId: string): RuntimeEvent[] {
  const raw = message as unknown as Record<string, unknown>;
  const events: RuntimeEvent[] = [];
  if (typeof raw.session_id === 'string' && raw.session_id !== sessionId) {
    events.push({ type: 'session', sessionId: raw.session_id });
  }

  if (raw.type === 'stream_event') {
    const event = raw.event as Record<string, unknown> | undefined;
    if (event?.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        events.push({ type: 'text_delta', delta: delta.text, sessionId });
      } else if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        events.push({
          type: 'thinking_delta',
          delta: delta.thinking,
          sessionId,
        });
      }
    }
  }

  if (raw.type === 'result') {
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : 'success';
    const text = textFromResult(raw);
    const result: RuntimeResult = {
      text,
      sessionId: typeof raw.session_id === 'string' ? raw.session_id : sessionId,
      finalizationReason:
        subtype === 'success' ? 'completed' : subtype.includes('interrupt') ? 'interrupted' : 'error',
      stopReason: subtype,
      error: subtype === 'success' ? undefined : text || subtype,
    };
    events.push({ type: 'result', sessionId: result.sessionId, result });
  }

  if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
    events.push({ type: 'compaction_end', sessionId, reason: 'native' });
  }

  return events;
}

class ClaudeRuntimeSession implements RuntimeSession {
  readonly kind = 'claude' as const;
  private queryRef?: Query;
  private readonly listeners = new Set<RuntimeEventListener>();
  private consumePromise?: Promise<void>;
  private disposed = false;
  private _sessionId: string;

  constructor(
    private readonly options: RuntimeSessionOptions & {
      queryOptions?: ClaudeQueryOptions;
    },
  ) {
    this._sessionId = options.sessionId || '';
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get isStreaming(): boolean {
    return !!this.queryRef;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private start(input: RuntimeInput): void {
    if (this.disposed) throw new Error('Claude runtime session is disposed');
    const q = query({
      prompt: input.text,
      options: {
        ...this.options.queryOptions,
        cwd: this.options.cwd,
        ...(this.options.sessionId ? { resume: this.options.sessionId } : {}),
      },
    });
    this.queryRef = q;
    this.consumePromise = (async () => {
      try {
        for await (const message of q) {
          const raw = message as unknown as Record<string, unknown>;
          if (typeof raw.session_id === 'string') this._sessionId = raw.session_id;
          for (const event of mapClaudeMessage(message, this._sessionId)) {
            this.emit(event);
          }
        }
      } catch (error) {
        this.emit({
          type: 'error',
          sessionId: this._sessionId,
          error: error instanceof Error ? error.message : String(error),
          fatal: !this.disposed,
        });
      } finally {
        this.queryRef = undefined;
      }
    })();
  }

  async prompt(input: RuntimeInput): Promise<void> {
    if (!this.queryRef) {
      this.start(input);
      return;
    }
    await this.followUp(input);
  }

  private async streamInput(input: RuntimeInput): Promise<void> {
    if (!this.queryRef) return this.start(input);
    await this.queryRef.streamInput(
      (async function* (sessionId: string) {
        yield toUserMessage(input, sessionId);
      })(this._sessionId),
    );
  }

  async steer(input: RuntimeInput): Promise<void> {
    await this.streamInput(input);
  }

  async followUp(input: RuntimeInput): Promise<void> {
    await this.streamInput(input);
  }

  async abort(): Promise<void> {
    await this.queryRef?.interrupt();
  }

  async compact(): Promise<void> {
    throw new Error(
      'Claude runtime compaction is owned by Claude Code native lifecycle; use the Pi adapter for explicit compact().',
    );
  }

  dispose(): void {
    this.disposed = true;
    this.queryRef?.close();
    this.queryRef = undefined;
    this.listeners.clear();
  }
}

export class ClaudeRuntimeAdapter implements AgentRuntime {
  readonly kind = 'claude' as const;

  constructor(private readonly queryOptions: ClaudeQueryOptions = {}) {}

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    return new ClaudeRuntimeSession({
      ...options,
      queryOptions: this.queryOptions,
    });
  }
}
