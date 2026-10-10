import { contextBridge, ipcRenderer } from 'electron';

export interface MiniclawDesktopConfig {
  appName: string;
  version: string;
  serverUrl: string;
  rendererUrl: string;
  isPackaged: boolean;
}

export interface MiniclawDesktopPickedFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type MiniclawDesktopShortcut = 'new-workspace';

export interface MiniclawDesktopAPI {
  getConfig(): Promise<MiniclawDesktopConfig>;
  openExternal(url: string): Promise<void>;
  retry(): Promise<void>;
  reload(): void;
  showAbout(): Promise<void>;
  showNotification(input: { title: string; body?: string }): Promise<boolean>;
  pickFiles(): Promise<MiniclawDesktopPickedFile[]>;
  onShortcut(listener: (shortcut: MiniclawDesktopShortcut) => void): () => void;
}

const api: MiniclawDesktopAPI = {
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  reload: () => ipcRenderer.send('desktop:reload'),
  showAbout: () => ipcRenderer.invoke('desktop:show-about'),
  showNotification: (input) =>
    ipcRenderer.invoke('desktop:show-notification', input),
  pickFiles: () => ipcRenderer.invoke('desktop:pick-files'),
  onShortcut: (listener) => {
    const handleShortcut = (
      _event: Electron.IpcRendererEvent,
      value: unknown,
    ) => {
      if (value === 'new-workspace') listener(value);
    };
    ipcRenderer.on('desktop:shortcut', handleShortcut);
    return () => ipcRenderer.removeListener('desktop:shortcut', handleShortcut);
  },
};

contextBridge.exposeInMainWorld('miniclawDesktop', api);
