import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { shouldPreloadChatRoute } from './chat-route-preload';

describe('chat route preload policy', () => {
  test.each([
    ['/', '', '/', true],
    ['/chat', '', '/', true],
    ['/chat/workspace', '', '/', true],
    ['/miniclaw/', '', '/miniclaw/', true],
    ['/miniclaw/chat/workspace', '', '/miniclaw/', true],
    ['/miniclaw/', '#/chat/workspace?agent=one', '/miniclaw/', true],
    ['/login', '', '/', false],
    ['/register', '', '/', false],
    ['/setup/providers', '', '/', false],
    ['/tasks', '', '/', false],
    ['/memory', '', '/', false],
    ['/miniclaw/tasks', '', '/miniclaw/', false],
    ['/miniclaw/', '#/memory', '/miniclaw/', false],
    ['/chatty', '', '/', false],
  ])('pathname=%s hash=%s base=%s => %s', (pathname, hash, base, expected) => {
    expect(shouldPreloadChatRoute(pathname, hash, base)).toBe(expected);
  });

  test('keeps production HTML route-neutral and starts the chat split from the route policy', () => {
    const app = fs.readFileSync(
      path.join(process.cwd(), 'web/src/App.tsx'),
      'utf8',
    );
    const viteConfig = fs.readFileSync(
      path.join(process.cwd(), 'web/vite.config.ts'),
      'utf8',
    );

    expect(viteConfig).not.toContain('modulepreload');
    expect(viteConfig).not.toContain('preloadChatChunks');
    expect(app).toContain('shouldPreloadChatRoute(');
    expect(app).toContain('void loadChatPage();');
  });
});
