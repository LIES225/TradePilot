import { describe, expect, it, vi } from 'vitest';
import { resolveAgentRuntimeKind } from '../container/agent-runner/src/runtime-config.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import { PiSubAgentAdapter } from '../container/agent-runner/src/runtime/pi/pi-subagents.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import { z } from 'zod';

describe('agent runtime migration contracts', () => {
  it('selects Pi by default and rejects unknown runtime selectors', () => {
    expect(resolveAgentRuntimeKind({})).toBe('pi');
    expect(resolveAgentRuntimeKind({ AGENT_RUNTIME: 'pi' })).toBe('pi');
    expect(resolveAgentRuntimeKind({ MINICLAW_AGENT_RUNTIME: 'pi' })).toBe(
      'pi',
    );
    expect(() => resolveAgentRuntimeKind({ AGENT_RUNTIME: 'other' })).toThrow(
      'expected claude or pi',
    );
  });

  it('namespaces Claude MCP tools for Pi without changing their handlers', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'delivered' }],
      ok: true,
    });
    const [tool] = adaptClaudeMcpToolsToPi(
      [
        {
          name: 'send_message',
          description: 'Send a message',
          inputSchema: { text: z.string() },
          handler,
        } as any,
      ],
      { namespace: 'mcp__miniclaw' },
    );

    expect(tool.name).toBe('mcp__miniclaw__send_message');
    const result = await tool.execute(
      'tool-call-1',
      { text: 'hello' },
      undefined,
      undefined,
      {} as any,
    );
    expect(handler).toHaveBeenCalledWith(
      { text: 'hello' },
      expect.objectContaining({ toolCallId: 'tool-call-1' }),
    );
    expect(result.content).toEqual([{ type: 'text', text: 'delivered' }]);
  });

  it('uses pi-subagents documented spawn/stop RPC and does not fake result RPC', async () => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const eventBus = {
      on(channel: string, listener: (value: unknown) => void) {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
      emit(channel: string, value: any) {
        if (channel === 'subagents:rpc:spawn') {
          for (const listener of listeners.get(
            `${channel}:reply:${value.requestId}`,
          ) ?? []) {
            listener({ success: true, data: { id: 'agent-1' } });
          }
        }
        if (channel === 'subagents:rpc:stop') {
          for (const listener of listeners.get(
            `${channel}:reply:${value.requestId}`,
          ) ?? []) {
            listener({ success: true });
          }
        }
      },
    };
    const adapter = new PiSubAgentAdapter(eventBus as any);

    await expect(
      adapter.spawn({ type: 'worker', prompt: 'do it', description: 'test' }),
    ).resolves.toMatchObject({ id: 'agent-1', status: 'running' });
    await expect(adapter.stop('agent-1')).resolves.toBeUndefined();
    await expect(adapter.getResult('agent-1')).rejects.toThrow(
      'does not publish a result RPC',
    );
  });

  it('bridges a Pi turn into the existing ContainerOutput stream', async () => {
    const listeners = new Set<(event: any) => void>();
    let disposed = false;
    const session = {
      kind: 'pi' as const,
      sessionId: 'pi-session-1',
      isStreaming: false,
      subscribe(listener: (event: any) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: 'text_delta',
            delta: 'hello',
            sessionId: 'pi-session-1',
          });
          listener({
            type: 'result',
            sessionId: 'pi-session-1',
            result: {
              text: 'hello',
              sessionId: 'pi-session-1',
              finalizationReason: 'completed',
              stopReason: 'stop',
              usage: { inputTokens: 3, outputTokens: 2 },
            },
          });
        }
      },
      async steer() {},
      async followUp() {},
      async abort() {},
      async compact() {},
      dispose() {
        disposed = true;
      },
    };
    const outputs: any[] = [];
    const result = await runPiQueryAttempt({
      runtime: { createSession: async () => session } as any,
      sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
      prompt: 'say hello',
      containerInput: {
        prompt: 'say hello',
        groupFolder: 'test',
        chatJid: 'test:chat',
      },
      tracker: new IpcTurnDeliveryTracker(),
      emit: (output) => outputs.push(output),
      log: () => {},
      drainInput: () => [],
      shouldClose: () => false,
      shouldInterrupt: () => false,
      acceptIpcMessagesDuringQuery: false,
      onSessionId: () => {},
      onTurnActivated: () => {},
      onTurnCompleted: () => {},
    });

    expect(outputs.some((output) => output.streamEvent?.text === 'hello')).toBe(
      true,
    );
    expect(outputs.at(-1)).toMatchObject({
      status: 'success',
      result: 'hello',
      newSessionId: 'pi-session-1',
      inputTurnCompleted: true,
    });
    expect(result.newSessionId).toBe('pi-session-1');
    expect(disposed).toBe(true);
  });
});
