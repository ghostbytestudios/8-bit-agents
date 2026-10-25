// Bundles the main process and preload (with the harness server inside) and copies in the built client.
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const CLIENT_DIST = here('../client/dist');
const OUT = here('dist');

if (!existsSync(CLIENT_DIST)) {
  console.error('Build the client first: npm run build (from the repo root).');
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Provided by the Electron runtime itself.
  external: ['electron'],
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'info',
};
await build({ ...common, entryPoints: [here('src/main.ts')], outfile: here('dist/main.cjs') });
// Sandboxed preloads can't require other files, so it is one self-contained bundle too.
await build({ ...common, entryPoints: [here('src/preload.ts')], outfile: here('dist/preload.cjs') });
await cp(CLIENT_DIST, here('dist/renderer'), { recursive: true });
