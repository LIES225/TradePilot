/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface Window {
  __MINICLAW_HASH_ROUTER__?: boolean;
  miniclawDesktop?: {
    showNotification(input: { title: string; body?: string }): Promise<boolean>;
    pickFiles(): Promise<
      Array<{ name: string; mimeType: string; bytes: Uint8Array }>
    >;
    onShortcut(listener: (shortcut: 'new-workspace') => void): () => void;
  };
}
