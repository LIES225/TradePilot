import { describe, expect, test } from 'vitest';

import {
  MINICLAW_SUBAGENT_RUNTIME_CONTRACT,
  withMiniclawSubagentContract,
} from '../container/agent-runner/src/sdk-compat.js';

describe('Claude SDK compatibility adapter', () => {
  test('adds only the short subagent contract and required CLI feature flag', () => {
    const result = withMiniclawSubagentContract(
      {
        systemPrompt: 'MAIN_MARKER',
        skills: ['review'],
        env: { EXISTING: 'kept' },
      },
      { PATH: '/bin' },
    );

    expect(result.options.systemPrompt).toBe('MAIN_MARKER');
    expect(result.options.appendSubagentSystemPrompt).toBe(
      MINICLAW_SUBAGENT_RUNTIME_CONTRACT,
    );
    expect(result.options.appendSubagentSystemPrompt).not.toContain(
      'MAIN_MARKER',
    );
    expect(result.options.skills).toEqual(['review']);
    expect(result.options.env).toMatchObject({
      PATH: '/bin',
      EXISTING: 'kept',
      CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT: '1',
    });
    expect(result.audit).toMatchObject({
      enabled: true,
      sdkCompatibility: 'claude-agent-sdk-0.3.205',
      cliCompatibility: 'claude-code-2.1.205',
    });
    expect(result.audit.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
