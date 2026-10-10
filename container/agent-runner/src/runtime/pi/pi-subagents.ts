import crypto from 'node:crypto';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { RuntimeEventListener } from '../types.js';

export type SubAgentSpec = {
  type: string;
  prompt: string;
  description: string;
  runInBackground?: boolean;
  resume?: string;
  inheritContext?: boolean;
  model?: string;
};

export type SubAgentResult = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
};

/**
 * Adapter over pi-subagents' documented event-bus RPC. Miniclaw does not
 * import the extension's internal classes, so the third-party package can be
 * replaced without changing the product runtime contract.
 */
export class PiSubAgentAdapter {
  constructor(
    private readonly eventBus: EventBus,
    private readonly emitRuntimeEvent?: RuntimeEventListener,
  ) {}

  async spawn(spec: SubAgentSpec): Promise<SubAgentResult> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const channel = `subagents:rpc:spawn:reply:${requestId}`;
      const unsubscribe = this.eventBus.on(channel, (value) => {
        unsubscribe();
        const reply = value as {
          success?: boolean;
          data?: { id?: string };
          error?: string;
        };
        if (!reply.success || !reply.data?.id) {
          reject(new Error(reply.error || 'Pi subagent spawn failed'));
          return;
        }
        resolve({ id: reply.data.id, status: 'running' });
      });
      this.eventBus.emit('subagents:rpc:spawn', {
        requestId,
        type: spec.type,
        prompt: spec.prompt,
        options: {
          description: spec.description,
          ...(spec.runInBackground !== undefined
            ? { run_in_background: spec.runInBackground }
            : {}),
          ...(spec.resume ? { resume: spec.resume } : {}),
          ...(spec.inheritContext !== undefined
            ? { inherit_context: spec.inheritContext }
            : {}),
          ...(spec.model ? { model: spec.model } : {}),
        },
      });
    });
  }

  onLifecycle(
    sessionId: string,
    listener: RuntimeEventListener = this.emitRuntimeEvent || (() => {}),
  ): () => void {
    const channels = [
      'subagents:created',
      'subagents:started',
      'subagents:completed',
      'subagents:failed',
      'subagents:steered',
      'subagents:compacted',
    ] as const;
    const unsubscribers = channels.map((channel) =>
      this.eventBus.on(channel, (data) => {
        const value = data as Record<string, unknown>;
        listener({
          type: 'subagent',
          sessionId,
          lifecycle: channel.slice('subagents:'.length) as
            | 'created'
            | 'started'
            | 'completed'
            | 'failed'
            | 'steered'
            | 'compacted',
          agentId: typeof value.id === 'string' ? value.id : undefined,
          result: typeof value.result === 'string' ? value.result : undefined,
          error: typeof value.error === 'string' ? value.error : undefined,
          details: value,
        });
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  async getResult(_agentId: string, _wait = false): Promise<SubAgentResult> {
    throw new Error(
      'Pi subagent result lookup is exposed by get_subagent_result inside the Pi session; pi-subagents does not publish a result RPC.',
    );
  }

  async steer(agentId: string, message: string): Promise<void> {
    void agentId;
    void message;
    throw new Error(
      'Pi subagent steering is exposed by steer_subagent inside the Pi session; pi-subagents does not publish a steer RPC.',
    );
  }

  async stop(agentId: string): Promise<void> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const channel = `subagents:rpc:stop:reply:${requestId}`;
      const unsubscribe = this.eventBus.on(channel, (value) => {
        unsubscribe();
        const reply = value as { success?: boolean; error?: string };
        if (!reply.success) {
          reject(new Error(reply.error || 'Pi subagent stop failed'));
          return;
        }
        resolve();
      });
      this.eventBus.emit('subagents:rpc:stop', {
        requestId,
        agentId,
      });
    });
  }
}
