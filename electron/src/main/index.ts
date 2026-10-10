import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'TradePilot';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const MAX_PICKED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PICKED_TOTAL_BYTES = 100 * 1024 * 1024;
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

type DesktopNotificationInput = {
  title: string;
  body?: string;
};

type DesktopPickedFile = {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
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
  const serverUrl = normalizeHttpUrl(serverValue, 'TradePilot server URL');
  const rendererValue =
    getCliValue('--renderer-url') ||
    process.env.MINICLAW_RENDERER_URL ||
    serverUrl;
  const rendererUrl = normalizeHttpUrl(rendererValue, 'TradePilot renderer URL');
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
    title: 'About TradePilot',
    message: 'TradePilot',
    detail: `Pi Agent Runtime workspace\nVersion ${app.getVersion()}`,
  } as const;
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function getMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.txt':
    case '.md':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function normalizeNotificationInput(input: unknown): DesktopNotificationInput {
  if (!input || typeof input !== 'object') {
    throw new Error('Notification input must be an object');
  }
  const { title, body } = input as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('Notification title must be a non-empty string');
  }
  if (body !== undefined && typeof body !== 'string') {
    throw new Error('Notification body must be a string');
  }
  return {
    title: title.trim().slice(0, 120),
    ...(typeof body === 'string' && body.trim()
      ? { body: body.trim().slice(0, 500) }
      : {}),
  };
}

function requireMainRenderer(event: Electron.IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents
  ) {
    throw new Error('Desktop IPC is only available to the main window');
  }
}

async function pickFiles(): Promise<DesktopPickedFile[]> {
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, {
          title: '选择要上传的文件',
          buttonLabel: '选择文件',
          properties: ['openFile', 'multiSelections'],
        })
      : await dialog.showOpenDialog({
          title: '选择要上传的文件',
          buttonLabel: '选择文件',
          properties: ['openFile', 'multiSelections'],
        });
  if (result.canceled) return [];

  const selectedFiles = await Promise.all(
    result.filePaths.map(async (filePath) => ({
      filePath,
      stat: await fs.promises.stat(filePath),
    })),
  );
  let totalBytes = 0;
  for (const { stat } of selectedFiles) {
    if (!stat.isFile()) throw new Error('Only files can be uploaded');
    if (stat.size > MAX_PICKED_FILE_BYTES) {
      throw new Error('Selected files must be 50 MB or smaller');
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_PICKED_TOTAL_BYTES) {
      throw new Error('Selected files must total 100 MB or smaller');
    }
  }

  return Promise.all(
    selectedFiles.map(async ({ filePath }) => ({
      name: path.basename(filePath),
      mimeType: getMimeType(filePath),
      bytes: new Uint8Array(await fs.promises.readFile(filePath)),
    })),
  );
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(path.join(__dirname, '..', 'assets', 'miniclaw-icon.png'));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 TradePilot', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showMainWindow);
}

function registerGlobalShortcuts(): void {
  const register = (accelerator: string, callback: () => void) => {
    if (!globalShortcut.register(accelerator, callback)) {
      console.warn(`[desktop] shortcut unavailable: ${accelerator}`);
    }
  };
  register('CommandOrControl+Shift+M', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showMainWindow();
  });
  register('CommandOrControl+Shift+N', () => {
    showMainWindow();
    mainWindow?.webContents.send('desktop:shortcut', 'new-workspace');
  });
}

function errorPageHtml(failedUrl: string): string {
  const safeUrl = JSON.stringify(failedUrl).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>TradePilot is unavailable</title>
<style>body{font:16px system-ui,sans-serif;background:#101114;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:620px;padding:32px;border:1px solid #34363d;border-radius:16px;background:#181a1f}h1{font-size:22px}p{color:#b7bbc5;line-height:1.5}code{word-break:break-all;color:#d8b4fe}button{border:0;border-radius:8px;background:#a78bfa;color:#17131f;padding:10px 16px;font-weight:600;cursor:pointer}</style>
</head><body><main><h1>TradePilot Backend 未连接</h1><p>请先启动 TradePilot Backend，或检查桌面应用配置的服务地址：</p><p><code>${safeUrl}</code></p><button id="retry">重试连接</button><script>document.getElementById('retry').addEventListener('click',()=>window.miniclawDesktop?.retry())</script></main></body></html>`;
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
  window.on('close', (event) => {
    saveWindowState();
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
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
  ipcMain.handle('desktop:show-notification', (event, input: unknown) => {
    requireMainRenderer(event);
    const notification = normalizeNotificationInput(input);
    if (!Notification.isSupported()) return false;
    const nativeNotification = new Notification(notification);
    nativeNotification.on('click', showMainWindow);
    nativeNotification.show();
    return true;
  });
  ipcMain.handle('desktop:pick-files', (event) => {
    requireMainRenderer(event);
    return pickFiles();
  });
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
      label: 'TradePilot',
      submenu: [
        { label: 'About TradePilot', click: () => void showAbout() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    viewMenu,
    {
      label: 'Help',
      submenu: [
        { label: 'TradePilot on GitHub', click: () => void openExternalUrl('https://github.com/helsome/miniclaw') },
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
    showMainWindow();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createApplicationMenu();
    createTray();
    registerGlobalShortcuts();
    createMainWindow();
    app.on('activate', () => {
      showMainWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    saveWindowState();
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
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
