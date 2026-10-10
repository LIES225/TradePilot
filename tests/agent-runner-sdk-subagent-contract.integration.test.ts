import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { PiSubAgentAdapter } from '../container/agent-runner/src/runtime/pi/pi-subagents.js';

describe('Pi delegated runtime contract', () => {
  test('production runner source and compiled entrypoint do not import Claude execution SDKs', () => {
    const root = path.resolve('container/agent-runner');
    const source = fs.readFileSync(path.join(root, 'src/pi-index.ts'), 'utf8');
    expect(source).not.toMatch(/@anthropic-ai\/(claude-agent-sdk|claude-code)/);
    const built = path.join(root, 'dist/pi-index.js');
    if (fs.existsSync(built)) {
      expect(fs.readFileSync(built, 'utf8')).not.toMatch(
        /@anthropic-ai\/(claude-agent-sdk|claude-code)/,
      );
    }
  });

  test('Pi subagent adapter uses explicit documented lifecycle boundaries', async () => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const eventBus = {
      on(channel: string, listener: (value: unknown) => void) {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
      emit(channel: string, value: any) {
        const replyChannel = `${channel}:reply:${value.requestId}`;
        for (const listener of listeners.get(replyChannel) ?? []) {
          listener(
            channel === 'subagents:rpc:spawn'
              ? { success: true, data: { id: 'pi-agent-1' } }
              : { success: true },
          );
        }
      },
    };
    const adapter = new PiSubAgentAdapter(eventBus as any);
    await expect(
      adapter.spawn({ type: 'worker', prompt: 'verify', description: 'test' }),
    ).resolves.toMatchObject({ id: 'pi-agent-1', status: 'running' });
    await expect(adapter.stop('pi-agent-1')).resolves.toBeUndefined();
    await expect(adapter.getResult('pi-agent-1')).rejects.toThrow(
      'does not publish a result RPC',
    );
  });
});
