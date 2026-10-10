/**
 * Runtime-neutral contracts used by the Agent Runner.
 *
 * The product protocol intentionally stays outside this module.  A runtime
 * adapter translates its native lifecycle into these events and the existing
 * runner remains responsible for ContainerOutput/StreamEvent correlation.
 */

export type RuntimeKind = 'claude' | 'pi';

export type RuntimeImage = {
  data: string;
  mimeType?: string;
};

export type RuntimeInput = {
  text: string;
  images?: RuntimeImage[];
};

export type RuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  durationMs?: number;
  numTurns?: number;
};

export type RuntimeResult = {
  text: string;
  sessionId: string;
  finalizationReason: 'completed' | 'interrupted' | 'error' | 'truncated';
  stopReason?: string;
  usage?: RuntimeUsage;
  error?: string;
};

export type RuntimeEvent =
  | {
      type: 'text_delta';
      delta: string;
      sessionId: string;
    }
  | {
      type: 'thinking_delta';
      delta: string;
      sessionId: string;
    }
  | {
      type: 'tool_start' | 'tool_update' | 'tool_end';
      sessionId: string;
      toolName: string;
      toolCallId?: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | {
      type: 'usage';
      sessionId: string;
      usage: RuntimeUsage;
    }
  | {
      type: 'session';
      sessionId: string;
    }
  | {
      type: 'status';
      sessionId: string;
      statusText: string;
    }
  | {
      type: 'compaction_start' | 'compaction_end';
      sessionId: string;
      reason?: string;
      error?: string;
    }
  | {
      type: 'subagent';
      sessionId: string;
      lifecycle:
        | 'created'
        | 'started'
        | 'completed'
        | 'failed'
        | 'steered'
        | 'compacted';
      agentId?: string;
      result?: string;
      error?: string;
      details?: unknown;
    }
  | {
      type: 'result';
      sessionId: string;
      result: RuntimeResult;
    }
  | {
      type: 'error';
      sessionId: string;
      error: string;
      fatal: boolean;
    };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type RuntimeSessionOptions = {
  cwd: string;
  sessionDir: string;
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  thinkingLevel?:
    | 'off'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max';
  allowedTools?: string[];
  excludedTools?: string[];
  /** Runtime-native custom tools. The Pi adapter accepts Pi ToolDefinitions. */
  customTools?: unknown[];
  /** Extra Agent Skills directories exposed through the runtime loader. */
  skillPaths?: string[];
  /** Extra extensions, including optional third-party adapters. */
  extensionPaths?: string[];
  /** Runtime-specific provider configuration. */
  provider?: {
    endpointKind?: 'official' | 'custom';
    baseUrl?: string;
    apiKey?: string;
  };
  /**
   * Product auto-compact toggle (default true). Maps to the runtime-native
   * compaction switch; the historical Claude SDK percentage/window knobs are
   * advisory only and do not control Pi's threshold.
   */
  autoCompactEnabled?: boolean;
};

export interface RuntimeSession {
  readonly kind: RuntimeKind;
  readonly sessionId: string;
  readonly isStreaming: boolean;
  prompt(input: RuntimeInput): Promise<void>;
  steer(input: RuntimeInput): Promise<void>;
  followUp(input: RuntimeInput): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  dispose(): void;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
}
