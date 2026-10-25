import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, contentTypeOf, isSafeExternalUrl, resolveAppFile } from './appFiles';

const ROOT = path.resolve('/bundle/renderer');

describe('resolveAppFile', () => {
  it('serves index.html at the root and files below it', () => {
    expect(resolveAppFile(ROOT, 'app://harness/')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveAppFile(ROOT, 'app://harness/assets/index-abc.js')).toBe(path.join(ROOT, 'assets', 'index-abc.js'));
  });

  it('refuses anything that escapes the bundle', () => {
    // The URL parser already folds "..", plain or %2e-encoded, so these stay inside the bundle.
    expect(resolveAppFile(ROOT, 'app://harness/../secrets.enc')).toBe(path.join(ROOT, 'secrets.enc'));
    expect(resolveAppFile(ROOT, 'app://harness/%2e%2e/%2e%2e/etc/passwd')).toBe(path.join(ROOT, 'etc', 'passwd'));
    // Encoded backslashes survive the parser; the bundle check has to catch them.
    expect(resolveAppFile(ROOT, 'app://harness/..%5C..%5Cwindows%5Cwin.ini')).toBeNull();
    expect(resolveAppFile(ROOT, 'app://harness/a%00.js')).toBeNull();
    expect(resolveAppFile(ROOT, 'app://harness/%E0%A4%A')).toBeNull();
  });

  it('refuses other hosts and schemes', () => {
    expect(resolveAppFile(ROOT, 'app://elsewhere/index.html')).toBeNull();
    expect(resolveAppFile(ROOT, 'file:///bundle/renderer/index.html')).toBeNull();
  });
});

describe('contentTypeOf', () => {
  it('knows the bundle types and falls back to octet-stream', () => {
    expect(contentTypeOf('x/index.html')).toMatch(/^text\/html/);
    expect(contentTypeOf('x/font.WOFF2')).toBe('font/woff2');
    expect(contentTypeOf('x/blob.bin')).toBe('application/octet-stream');
  });
});

describe('contentSecurityPolicy', () => {
  it('allows only the bundle and the local server socket', () => {
    const csp = contentSecurityPolicy(51234);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:51234");
    expect(csp).not.toMatch(/unsafe-eval|https:/);
  });
});

describe('isSafeExternalUrl', () => {
  it('opens plain https links only', () => {
    expect(isSafeExternalUrl('https://console.anthropic.com/settings/keys')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isSafeExternalUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});
