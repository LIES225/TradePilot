import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-tool-init-'));
const runnerRoot = path.resolve('container/agent-runner');

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function toolNames(
  isHome: boolean,
  options: {
    isScheduledTask?: boolean;
    currentTaskId?: string | null;
    agentBuilderEnabled?: boolean;
  } = {},
): string[] {
  return createMcpTools({
    chatJid: 'web:tool-init',
    groupFolder: 'tool-init',
    isHome,
    isAdminHome: true,
    agentBuilderEnabled: options.agentBuilderEnabled ?? isHome,
    isScheduledTask: options.isScheduledTask ?? false,
    currentTaskId: options.currentTaskId ?? null,
    currentInputTurnId: 'turn-1',
    workspaceIpc: '/tmp/tool-init-ipc',
    workspaceGroup: '/tmp/tool-init-group',
  }).map((tool) => tool.name);
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('Miniclaw tool initialization', () => {
  test('uses the Pi runtime packages pinned by the runner build', () => {
    const runnerPackage = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const runnerLock = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package-lock.json'), 'utf8'),
    ) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };
    const pinnedPi =
      runnerPackage.dependencies['@earendil-works/pi-coding-agent'];
    const pinnedSubagents =
      runnerPackage.dependencies['@tintinweb/pi-subagents'];
    expect(pinnedPi).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinnedSubagents).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      runnerLock.packages['node_modules/@earendil-works/pi-coding-agent']
        .version,
    ).toBe(pinnedPi);
    expect(
      runnerLock.packages['node_modules/@tintinweb/pi-subagents'].version,
    ).toBe(pinnedSubagents);
    expect(runnerPackage.dependencies).not.toHaveProperty(
      '@anthropic-ai/claude-agent-sdk',
    );
    expect(runnerPackage.dependencies).not.toHaveProperty(
      '@anthropic-ai/claude-code',
    );
    expect(fs.readFileSync('container/Dockerfile', 'utf8')).toContain(
      'COPY agent-runner/package.json agent-runner/package-lock.json ./',
    );
  });

  test('main-Agent runtime exposes the complete tool set and Agent Builder', () => {
    const names = toolNames(true);
    expect(names).toEqual(
      expect.arrayContaining([
        'schedule_task',
        'install_skill',
        'workspace_memory_search',
        'workspace_memory_get',
        'workspace_memory_remember',
        'workspace_memory_update',
        'workspace_memory_forget',
        'agent_profile_list',
        'agent_profile_get',
        'agent_profile_draft_get',
        'agent_capability_catalog',
        'agent_profile_prepare',
        'agent_profile_publish',
        'agent_profile_discard',
      ]),
    );
  });

  test('main Agent exposes Agent Builder in every workspace', () => {
    const names = toolNames(false, { agentBuilderEnabled: true });
    expect(names).toContain('agent_profile_prepare');
    expect(names).toContain('agent_profile_publish');
  });

  test('custom Agent runtime keeps ordinary tools but does not advertise Agent Builder', () => {
    const names = toolNames(false, { agentBuilderEnabled: false });
    expect(names).toContain('schedule_task');
    expect(names).toEqual(
      expect.arrayContaining([
        'workspace_memory_search',
        'workspace_memory_get',
        'workspace_memory_remember',
        'workspace_memory_update',
        'workspace_memory_forget',
      ]),
    );
    expect(names).not.toContain('install_skill');
    expect(names).not.toContain('agent_profile_prepare');
  });

  test('home tool registration stays stable across scheduled and human turns', () => {
    expect(toolNames(true, { isScheduledTask: true })).toContain(
      'agent_profile_prepare',
    );
    expect(
      toolNames(true, { currentTaskId: 'scheduled-group-task' }),
    ).toContain('agent_profile_publish');
  });

  test('scheduled and task-triggered turns expose Workspace Memory read-only', () => {
    for (const names of [
      toolNames(false, { isScheduledTask: true }),
      toolNames(false, { currentTaskId: 'scheduled-group-task' }),
    ]) {
      expect(names).toContain('workspace_memory_search');
      expect(names).toContain('workspace_memory_get');
      expect(names).not.toContain('workspace_memory_remember');
      expect(names).not.toContain('workspace_memory_update');
      expect(names).not.toContain('workspace_memory_forget');
    }
  });

  test('production runner entrypoint is Pi-only at source and build output', () => {
    const source = fs.readFileSync(
      path.join(runnerRoot, 'src/pi-index.ts'),
      'utf8',
    );
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(source).not.toContain('@anthropic-ai/claude-code');
    const built = path.join(runnerRoot, 'dist/pi-index.js');
    if (fs.existsSync(built)) {
      const output = fs.readFileSync(built, 'utf8');
      expect(output).not.toContain('@anthropic-ai/claude-agent-sdk');
      expect(output).not.toContain('@anthropic-ai/claude-code');
    }
  });
});
