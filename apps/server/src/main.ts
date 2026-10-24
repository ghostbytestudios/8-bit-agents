import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config';
import { RunHub } from './hub';
import { Run } from './orchestrator';
import { createProviders, credentialEnvNames } from './providers';
import { startServer } from './server';
import { Workspace } from './workspace';

/** Local-only unless you deliberately change it. */
const HOST = '127.0.0.1';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_PATH = process.env.HARNESS_CONFIG ?? path.join(REPO_ROOT, 'harness.config.json');
/** Read by apps/client/vite.config.ts; gitignored. */
const TOKEN_PATH = path.join(REPO_ROOT, '.harness', 'session-token');

/** True when `child` is `parent` or anything below it. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A fresh random token per server start, readable only by your user. The Vite dev proxy
 * forwards it, so only pages served by your own dev server can open the socket.
 */
async function writeSessionToken(): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

async function main(): Promise<void> {
  // An explicitly named config that's missing is a mistake, not a reason to quietly use the defaults.
  if (process.env.HARNESS_CONFIG && !existsSync(CONFIG_PATH)) throw new ConfigError(`HARNESS_CONFIG points to ${CONFIG_PATH}, which does not exist.`);
  const { config, isDefault } = loadConfig(CONFIG_PATH);
  const workspaceDir = path.resolve(REPO_ROOT, config.workspace);
  // Agents must never be able to read this repo's config, .env or .git through their workspace.
  if (isWithin(workspaceDir, REPO_ROOT) || isWithin(workspaceDir, os.homedir())) {
    throw new ConfigError(`"workspace" (${workspaceDir}) contains the harness repo or your home folder; point it at a dedicated folder.`);
  }
  const providers = createProviders(config, process.env);
  const workspace = await Workspace.open(workspaceDir, credentialEnvNames(config));
  const hub = new RunHub((emit) => new Run({ config, providers, workspace, emit }));
  const sessionToken = await writeSessionToken();
  const server = await startServer({ hub, host: HOST, port: config.port, allowedOrigins: config.allowedOrigins, sessionToken });

  console.info(`Harness server on ws://${HOST}:${server.port}/ws`);
  console.info(isDefault ? 'No harness.config.json found: using Claude for every role (see harness.config.example.json).' : `Config: ${CONFIG_PATH}`);
  for (const [role, { provider, model }] of Object.entries(config.roles)) {
    const where = providers.get(provider)?.isLocal ? 'local' : 'remote';
    console.info(`  ${role.padEnd(9)} → ${provider} / ${model} (${where})`);
  }
  console.info(`Workspace: ${workspace.root}`);
  console.info(`Budget: $${config.limits.maxRunCostUsd.toFixed(2)} per run (limits.maxRunCostUsd)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
