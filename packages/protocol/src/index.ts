/**
 * The contract between agent backends (mock, harness server, Claude Code hooks) and the
 * office. Everything crossing that boundary is validated with these schemas.
 */
import { z } from 'zod';

/** The product name people see: window title, top bar, installer, data folder. */
export const APP_NAME = '8Bit Agents';

export const MAX_TEXT = 10_000;

const id = z.string().min(1).max(128);
const text = z.string().max(MAX_TEXT);

export const AgentRoleSchema = z.enum(['boss', 'architect', 'worker', 'reviewer', 'researcher']);
export const AgentStatusSchema = z.enum(['idle', 'thinking', 'working', 'blocked', 'done', 'error']);
export const TaskStateSchema = z.enum(['todo', 'doing', 'review', 'done', 'failed']);
export const HumanInputKindSchema = z.enum(['question', 'approval', 'choice']);

export const RunStatusSchema = z.enum(['done', 'stopped', 'failed']);

export const HarnessEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), goal: text }),
  z.object({ type: z.literal('run.finished'), status: RunStatusSchema, summary: text }),
  z.object({
    type: z.literal('agent.spawned'),
    agentId: id,
    role: AgentRoleSchema,
    name: z.string().min(1).max(64),
    model: z.string().max(128),
    /** Which configured provider runs this agent (e.g. "claude", "ollama"). */
    provider: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal('agent.status'), agentId: id, status: AgentStatusSchema }),
  z.object({ type: z.literal('tool.started'), agentId: id, toolCallId: id, tool: z.string().min(1).max(128), summary: text }),
  z.object({ type: z.literal('tool.finished'), agentId: id, toolCallId: id, ok: z.boolean(), summary: text.optional() }),
  z.object({ type: z.literal('message.sent'), from: id, to: id, text }),
  z.object({ type: z.literal('task.created'), taskId: id, title: z.string().min(1).max(200), parentId: id.optional() }),
  z.object({ type: z.literal('task.assigned'), taskId: id, agentId: id }),
  z.object({ type: z.literal('task.updated'), taskId: id, state: TaskStateSchema }),
  z.object({ type: z.literal('plan.updated'), agentId: id, mermaid: text.optional(), markdown: text.optional() }),
  z.object({
    type: z.literal('human.input_requested'),
    requestId: id,
    agentId: id,
    prompt: text,
    options: z.array(z.string().max(200)).max(10).optional(),
    kind: HumanInputKindSchema,
  }),
  z.object({ type: z.literal('human.input_resolved'), requestId: id, answer: text }),
  z.object({
    type: z.literal('usage'),
    agentId: id,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('log'), agentId: id, level: z.enum(['info', 'warn', 'error']), text }),
]);

/** Every event travels in an envelope; `seq` only ever increases within a run. */
export const EnvelopeSchema = z.object({
  id,
  runId: id,
  ts: z.number().nonnegative(),
  seq: z.number().int().nonnegative(),
  event: HarnessEventSchema,
});

// ── Settings (the desktop app's settings screen) ─────────────────────────────

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color like #63c74d');
const agentName = z.string().trim().min(1).max(20);
const providerId = z.string().regex(/^[a-z0-9-]{1,32}$/, 'lowercase letters, digits and dashes');

export const ProviderPresetSchema = z.enum(['claude', 'openai', 'openrouter', 'groq', 'ollama', 'lmstudio', 'custom']);
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

export interface PresetInfo {
  label: string;
  kind: 'anthropic' | 'openai-compatible';
  /** Fixed endpoint; null means the user types one (custom) or the SDK knows it (Claude). */
  baseUrl: string | null;
  needsKey: boolean;
  /** Where to create a key, shown next to the key field. */
  keyUrl: string | null;
  /** Suggested model ids until "Test connection" lists the real ones. */
  models: readonly string[];
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderPreset, PresetInfo>> = {
  claude: { label: 'Claude', kind: 'anthropic', baseUrl: null, needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  openai: { label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', models: [] },
  openrouter: { label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/keys', models: [] },
  groq: { label: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, keyUrl: 'https://console.groq.com/keys', models: [] },
  ollama: { label: 'Ollama (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, keyUrl: null, models: ['qwen2.5-coder:14b'] },
  lmstudio: { label: 'LM Studio (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, keyUrl: null, models: [] },
  custom: { label: 'Custom (OpenAI-compatible)', kind: 'openai-compatible', baseUrl: null, needsKey: false, keyUrl: null, models: [] },
};

export const ProviderSettingsSchema = z.object({
  id: providerId,
  preset: ProviderPresetSchema,
  label: z.string().trim().min(1).max(40),
  /** Only for the custom preset. */
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
});

export const RoleSettingsSchema = z.object({
  provider: providerId,
  model: z.string().trim().min(1).max(128),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export const TeamMemberSchema = z.object({ name: agentName, shirt: hexColor, hair: hexColor });

export const AppSettingsSchema = z.object({
  version: z.literal(1),
  providers: z.array(ProviderSettingsSchema).min(1).max(12),
  roles: z.object({ boss: RoleSettingsSchema, architect: RoleSettingsSchema, worker: RoleSettingsSchema }),
  team: z.object({
    workers: z.number().int().min(1).max(8),
    boss: TeamMemberSchema,
    architect: TeamMemberSchema,
    /** One entry per worker seat (index 0 = worker-1). */
    workerLooks: z.array(TeamMemberSchema).length(8),
  }),
  appearance: z.object({
    hudTheme: z.enum(['night', 'day', 'contrast']),
    accent: hexColor,
    palette: z.boolean(),
    dither: z.boolean(),
    outline: z.boolean(),
    zoom: z.number().int().min(1).max(4),
  }),
  limits: z.object({
    maxRunCostUsd: z.number().positive().max(1_000),
    maxRunTokens: z.number().int().positive().max(1_000_000_000),
    maxTurnsPerTask: z.number().int().min(1).max(200),
    maxTasks: z.number().int().min(1).max(100),
    maxRounds: z.number().int().min(1).max(10),
  }),
  /** Folder the agents work in. */
  workspace: z.string().trim().min(1).max(500),
}).superRefine((settings, context) => {
  const ids = settings.providers.map((provider) => provider.id);
  ids.forEach((id, index) => {
    if (ids.indexOf(id) !== index) context.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: `duplicate provider "${id}"` });
  });
  settings.providers.forEach((provider, index) => {
    if (provider.preset === 'custom' && !provider.baseUrl) context.addIssue({ code: 'custom', path: ['providers', index, 'baseUrl'], message: 'a custom provider needs a URL' });
  });
  for (const [role, { provider }] of Object.entries(settings.roles)) {
    if (!ids.includes(provider)) context.addIssue({ code: 'custom', path: ['roles', role, 'provider'], message: `no provider "${provider}"` });
  }
});

/** What the UI may know about a stored key: whether it exists and its last 4 characters. Never the key. */
export const KeyStatusSchema = z.record(providerId, z.object({ isSet: z.boolean(), last4: z.string().max(4).optional() }));

export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

// ── Workspace files and skills (the War Room's cabinet and shelf) ────────────

export const MAX_SKILL_BODY = 16_000;
export const MAX_SKILLS = 100;
export const MAX_FILE_ENTRIES = 2_000;
/** Room for the server's 100 KB read cap plus its truncation note. */
export const MAX_FILE_PREVIEW_CHARS = 120_000;
const workspacePath = z.string().min(1).max(500);

/** The roles a skill can be given to. */
export const SkillRoleSchema = z.enum(['boss', 'architect', 'worker']);
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A SKILL.md file: when to use it (description) and what it says (body). */
export const SkillSchema = z.object({
  id: z.string().regex(SKILL_ID_PATTERN, 'lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(300),
  roles: z.array(SkillRoleSchema).min(1).max(3),
  enabled: z.boolean(),
  body: z.string().max(MAX_SKILL_BODY),
});

/** Saving without an id creates a new skill. */
export const SkillDraftSchema = SkillSchema.extend({ id: SkillSchema.shape.id.optional() });

export type SkillRole = z.infer<typeof SkillRoleSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export const HarnessCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings.update'), settings: AppSettingsSchema }),
  /** Keys travel browser → server once and are never sent back. */
  z.object({ type: z.literal('provider.setKey'), providerId, key: z.string().trim().min(8).max(500) }),
  z.object({ type: z.literal('provider.clearKey'), providerId }),
  z.object({ type: z.literal('provider.test'), providerId }),
  z.object({ type: z.literal('run.start'), goal: z.string().min(1).max(MAX_TEXT) }),
  z.object({ type: z.literal('run.stop'), runId: id }),
  z.object({ type: z.literal('human.respond'), requestId: id, answer: text }),
  z.object({ type: z.literal('agent.message'), agentId: id, text }),
  z.object({ type: z.enum(['agent.pause', 'agent.resume', 'agent.stop']), agentId: id }),
  z.object({ type: z.literal('files.list') }),
  z.object({ type: z.literal('file.read'), path: workspacePath }),
  z.object({ type: z.literal('skills.list') }),
  z.object({ type: z.literal('skill.save'), skill: SkillDraftSchema }),
  z.object({ type: z.literal('skill.delete'), id: SkillSchema.shape.id }),
]);

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;
const MAX_REPLAY_EVENTS = 20_000;

/** Server → browser, over the WebSocket. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.number().int(), runId: id.nullable() }),
  /** Everything that happened in the current run so far, sent once right after `hello`. */
  z.object({ type: z.literal('replay'), envelopes: z.array(EnvelopeSchema).max(MAX_REPLAY_EVENTS) }),
  z.object({ type: z.literal('event'), envelope: EnvelopeSchema }),
  z.object({ type: z.literal('ack'), commandId: id, ok: z.boolean(), error: z.string().max(500).optional() }),
  /** Current settings; sent after hello and whenever they change. */
  z.object({ type: z.literal('settings'), settings: AppSettingsSchema, keys: KeyStatusSchema }),
  /** Result of "Test connection", with the models the provider offers. */
  z.object({
    type: z.literal('provider.tested'),
    providerId,
    ok: z.boolean(),
    detail: z.string().max(500),
    models: z.array(z.string().max(128)).max(500),
  }),
  /** The workspace's files: paths relative to `root`, folders end in "/". */
  z.object({
    type: z.literal('files'),
    root: z.string().max(500),
    entries: z.array(z.string().max(600)).max(MAX_FILE_ENTRIES),
    truncated: z.boolean(),
  }),
  z.object({ type: z.literal('file'), path: workspacePath, content: z.string().max(MAX_FILE_PREVIEW_CHARS) }),
  /** Every skill on the shelf; sent on request and whenever one changes. */
  z.object({ type: z.literal('skills'), skills: z.array(SkillSchema).max(MAX_SKILLS) }),
]);

/** Browser → server. `commandId` lets the server acknowledge (or reject) each command. */
export const ClientMessageSchema = z.object({
  type: z.literal('command'),
  commandId: id,
  command: HarnessCommandSchema,
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type HumanInputKind = z.infer<typeof HumanInputKindSchema>;
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessEventType = HarnessEvent['type'];
export type EventOfType<K extends HarnessEventType> = Extract<HarnessEvent, { type: K }>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type HarnessCommand = z.infer<typeof HarnessCommandSchema>;

/**
 * A source of events: the in-browser mock, or a WebSocket to the harness server.
 * Listeners receive raw, unvalidated data — parse it with `EnvelopeSchema` at the boundary.
 */
export interface EventFeed {
  /** True when the events are invented (the mock), so the HUD never shows fake costs as real. */
  readonly isSimulated: boolean;
  subscribe(listener: (raw: unknown) => void): () => void;
  /** False when the command could not be sent (e.g. disconnected). */
  send(command: HarnessCommand): boolean;
}
