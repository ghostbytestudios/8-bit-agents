/** What the desktop app's preload script exposes to the page; absent in a plain browser. */
export interface DesktopBridge {
  /** The in-process harness server's socket address. */
  readonly serverUrl: string;
}

declare global {
  interface Window {
    readonly harnessDesktop?: DesktopBridge;
  }
}

/**
 * The desktop app names its own server; in the browser the page talks to the
 * Vite dev proxy on its own origin.
 */
export function serverUrl(): string {
  const desktopUrl = window.harnessDesktop?.serverUrl;
  if (typeof desktopUrl === 'string' && /^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(desktopUrl)) return desktopUrl;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
