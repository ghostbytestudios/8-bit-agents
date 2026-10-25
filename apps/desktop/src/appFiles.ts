import path from 'node:path';
import { isWithin } from '@harness/server/app';

/** The window's own origin. Pages come from the bundled client, never from the network. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'harness';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** The bundled file a request names, or null for anything outside the bundle. */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // Bundle paths never contain these; a backslash is a separator on Windows only, so refuse it everywhere.
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  return isWithin(root, file) && file !== path.resolve(root) ? file : null;
}

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Only the bundle and the in-process server; no remote scripts, frames, forms or plugins. */
export function contentSecurityPolicy(serverPort: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // 'self' covers fetch() of bundled files (the furniture models); the socket is the only other way out.
    `connect-src 'self' ws://127.0.0.1:${serverPort}`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Links the app may hand to the system browser (e.g. "GET A KEY"): plain https only. */
export function isSafeExternalUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
