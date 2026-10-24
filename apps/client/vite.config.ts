import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Where `npm run server` listens (harness.config.json "port"). */
const SERVER_PORT = Number(process.env.HARNESS_SERVER_PORT ?? 8787);
/** Written by the server on start; re-read per connection so a restarted server's new token is picked up. */
const TOKEN_PATH = fileURLToPath(new URL('../../.harness/session-token', import.meta.url));

function readSessionToken(): string | null {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export default defineConfig({
  server: {
    proxy: {
      // The page talks to the harness server same-origin. The browser's Origin header passes
      // through unchanged, and the proxy adds the session token the page itself never sees.
      '/ws': {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            const token = readSessionToken();
            if (token) proxyReq.setHeader('x-harness-token', token);
          });
        },
      },
    },
  },
});
