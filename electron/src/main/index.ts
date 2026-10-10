import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'Miniclaw';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const WINDOW_DEFAULTS = {
  width: 1440,
  height: 920,
  minWidth: 960,
  minHeight: 640,
};

type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
};

type DesktopConfig = {
  appName: string;
  version: string;
  serverUrl: string;
  rendererUrl: string;
  isPackaged: boolean;
};

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function getCliValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizeHttpUrl(rawValue: string, label: string): string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http:// or https://`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }

  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function resolveDesktopUrls(): { serverUrl: string; rendererUrl: string } {
  const serverValue =
    getCliValue('--server-url') ||
    process.env.MINICLAW_SERVER_URL ||
    DEFAULT_SERVER_URL;
  const serverUrl = normalizeHttpUrl(serverValue, 'Miniclaw server URL');
  const rendererValue =
    getCliValue('--renderer-url') ||
    process.env.MINICLAW_RENDERER_URL ||
    serverUrl;
  const rendererUrl = normalizeHttpUrl(rendererValue, 'Miniclaw renderer URL');
  return { serverUrl, rendererUrl };
}

const { serverUrl, rendererUrl } = resolveDesktopUrls();

function getDesktopConfig(): DesktopConfig {
  return {
    appName: APP_NAME,
    version: app.getVersion(),
    serverUrl,
    rendererUrl,
    isPackaged: app.isPackaged,
  };
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function loadWindowState(): WindowState {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf8')) as Partial<WindowState>;
    return {
      width: isFinitePositive(parsed.width) ? parsed.width : WINDOW_DEFAULTS.width,
      height: isFinitePositive(parsed.height) ? parsed.height : WINDOW_DEFAULTS.height,
      ...(isFinitePositive(parsed.x) ? { x: parsed.x } : {}),
      ...(isFinitePositive(parsed.y) ? { y: parsed.y } : {}),
      isMaximized: parsed.isMaximized === true,
    };
  } catch {
    return { width: WINDOW_DEFAULTS.width, height: WINDOW_DEFAULTS.height };
  }
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: mainWindow.isMaximized(),
  };

  try {
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    console.warn('[desktop] failed to save window state', error);
  }
}

function isAllowedRendererUrl(rawUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl);
    const allowed = new Set([new URL(serverUrl).origin, new URL(rendererUrl).origin]);
    return (candidate.protocol === 'http:' || candidate.protocol === 'https:') && allowed.has(candidate.origin);
  } catch {
    return false;
  }
}

async function openExternalUrl(rawUrl: string): Promise<void> {
  let candidate: URL;
  try {
    candidate = new URL(rawUrl);
  } catch {
    throw new Error('Only valid external URLs can be opened');
  }

  if (!['http:', 'https:', 'mailto:'].includes(candidate.protocol)) {
    throw new Error('Only http, https, and mailto links can be opened');
  }
  await shell.openExternal(candidate.toString());
}

function showAbout(): Promise<Electron.MessageBoxReturnValue> {
  const options = {
    type: 'info',
    title: 'About Miniclaw',
    message: 'Miniclaw',
    detail: `Pi Agent Runtime workspace\nVersion ${app.getVersion()}`,
  } as const;
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function errorPageHtml(failedUrl: string): string {
  const safeUrl = JSON.stringify(failedUrl).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Miniclaw is unavailable</title>
<style>body{font:16px system-ui,sans-serif;background:#101114;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:620px;padding:32px;border:1px solid #34363d;border-radius:16px;background:#181a1f}h1{font-size:22px}p{color:#b7bbc5;line-height:1.5}code{word-break:break-all;color:#d8b4fe}button{border:0;border-radius:8px;background:#a78bfa;color:#17131f;padding:10px 16px;font-weight:600;cursor:pointer}</style>
</head><body><main><h1>Miniclaw Backend 未连接</h1><p>请先启动 Miniclaw Backend，或检查桌面应用配置的服务地址：</p><p><code>${safeUrl}</code></p><button id="retry">重试连接</button><script>document.getElementById('retry').addEventListener('click',()=>window.miniclawDesktop?.retry())</script></main></body></html>`;
}

async function loadRenderer(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.loadURL(rendererUrl);
  } catch (error) {
    console.warn('[desktop] renderer could not load', error);
    if (!mainWindow.isDestroyed()) {
      await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(rendererUrl))}`);
    }
  }
}

function createMainWindow(): BrowserWindow {
  const state = loadWindowState();
  const window = new BrowserWindow({
    ...state,
    ...WINDOW_DEFAULTS,
    width: state.width,
    height: state.height,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    show: false,
    title: APP_NAME,
    backgroundColor: '#101114',
    icon: path.join(__dirname, '..', 'assets', 'miniclaw-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url).catch((error) => console.warn('[desktop] blocked external URL', error));
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRendererUrl(url)) return;
    event.preventDefault();
    void openExternalUrl(url).catch((error) => console.warn('[desktop] blocked navigation', error));
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith('data:')) return;
    console.warn(`[desktop] renderer load failed (${errorCode}): ${errorDescription}`);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(validatedURL || rendererUrl))}`);
  });

  window.once('ready-to-show', () => {
    if (state.isMaximized) window.maximize();
    window.show();
  });
  window.on('close', saveWindowState);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  mainWindow = window;
  void loadRenderer();
  return window;
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-config', () => getDesktopConfig());
  ipcMain.handle('desktop:open-external', (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('External URL must be a string');
    return openExternalUrl(url);
  });
  ipcMain.handle('desktop:retry', () => loadRenderer());
  ipcMain.on('desktop:reload', () => mainWindow?.reload());
  ipcMain.handle('desktop:show-about', () => showAbout());
}

function createApplicationMenu(): void {
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Miniclaw',
      submenu: [
        { label: 'About Miniclaw', click: () => void showAbout() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    viewMenu,
    {
      label: 'Help',
      submenu: [
        { label: 'Miniclaw on GitHub', click: () => void openExternalUrl('https://github.com/helsome/miniclaw') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createApplicationMenu();
    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    saveWindowState();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('browser-window-created', (_event, window) => {
    window.on('close', () => {
      if (!isQuitting) saveWindowState();
    });
  });
}
