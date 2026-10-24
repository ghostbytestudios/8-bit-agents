import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * harness.config.json: which provider and model each role uses, plus run limits.
 * API keys never live here — only the *name* of the environment variable holding one.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const EnvVarName =z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable name like MY_API_KEY');
const Price = z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() });

const ProviderConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('anthropic'), apiKeyEnv: EnvVarName.optional() }),
  z.object({
    type: z.literal('openai-compatible'),
    baseUrl: z.url({ protocol: /^https?$/ }),
    apiKeyEnv: EnvVarName.optional(),
    /** $ per million tokens by model id; models without an entry cost $0 (typical for local). */
    pricing: z.record(z.string(), Price).optional(),
  }),
]);

const RoleSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).max(128),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

const LimitsSchema = z.object({
  /** The run stops once its metered spend passes this. */
  maxRunCostUsd: z.number().positive().default(5),
  /** Also stops the run, priced or not, so unpriced or local models are bounded too. */
  maxRunTokens: z.number().int().positive().default(3_000_000),
  maxTurnsPerTask: z.number().int().min(1).max(200).default(30),
  maxTasks: z.number().int().min(1).max(100).default(20),
  /** Times the Boss may plan follow-up work after a batch of tasks finishes. */
  maxRounds: z.number().int().min(1).max(10).default(3),
});

export const HarnessConfigSchema = z.object({
  providers: z.record(z.string().regex(/^[a-z0-9-]{1,32}$/, 'provider names are lowercase letters, digits and dashes'), ProviderConfigSchema),
  roles: z.object({ boss: RoleSchema, architect: RoleSchema, worker: RoleSchema }),
  workers: z.number().int().min(1).max(8).default(3),
  workspace: z.string().min(1).default('./workspace'),
  port: z.number().int().min(1024).max(65535).default(8787),
  /** Browser origins allowed to open the WebSocket (protects against other sites driving your agents). */
  allowedOrigins: z.array(z.url()).default(['http://localhost:5173', 'http://127.0.0.1:5173']),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
}).superRefine((config, context) => {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.type !== 'openai-compatible' || !provider.apiKeyEnv) continue;
    const url = new URL(provider.baseUrl);
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      context.addIssue({ code: 'custom', path: ['providers', name, 'baseUrl'], message: 'use https:// when sending an API key to another machine' });
    }
  }
  for (const [role, { provider }] of Object.entries(config.roles)) {
    if (!(provider in config.providers)) {
      context.addIssue({ code: 'custom', path: ['roles', role, 'provider'], message: `no provider named "${provider}" in "providers"` });
    }
  }
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export interface TeamNames {
  boss: string;
  architect: string;
  /** Index 0 is worker-1. */
  workers: readonly string[];
}

/** What one run needs: who plays each role, the team size and names, and the limits. */
export type RunConfig = Pick<HarnessConfig, 'roles' | 'workers' | 'limits'> & { names?: TeamNames };
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type RoleName = keyof HarnessConfig['roles'];

/** Used when there is no config file: everything on Claude. */
export const DEFAULT_CONFIG_INPUT = {
  providers: { claude: { type: 'anthropic' } },
  roles: {
    boss: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    architect: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    worker: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  },
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(raw: unknown, source: string): HarnessConfig {
  const parsed = HarnessConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${source} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadConfig(path: string): { config: HarnessConfig; isDefault: boolean } {
  if (!existsSync(path)) return { config: parseConfig(DEFAULT_CONFIG_INPUT, 'default config'), isDefault: true };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { config: parseConfig(raw, path), isDefault: false };
}
