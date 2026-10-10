import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const mainSource = readFileSync(
  resolve(projectRoot, 'electron/src/main/index.ts'),
  'utf8',
);
const preloadSource = readFileSync(
  resolve(projectRoot, 'electron/src/preload/index.ts'),
  'utf8',
);
const builderConfig = readFileSync(
  resolve(projectRoot, 'electron/electron-builder.yml'),
  'utf8',
);

describe('Electron Desktop Shell contract', () => {
  it('keeps privileged capabilities in Main and exposes a narrow Preload bridge', () => {
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).toContain("ipcMain.handle('desktop:open-external'");
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld');
    expect(preloadSource).not.toContain('fs');
    expect(preloadSource).not.toContain('child_process');
  });

  it('keeps packaging focused on the desktop shell', () => {
    expect(builderConfig).toContain('productName: Miniclaw');
    expect(builderConfig).toContain('icon: assets/miniclaw-icon.png');
    expect(builderConfig).toContain('icon: assets/miniclaw.icns');
    expect(builderConfig).toContain('assets/**/*');
    expect(builderConfig).toContain('dist/**/*');
    expect(builderConfig).toContain('extraMetadata:');
  });
});
