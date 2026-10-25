import { mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_SKILL_BODY,
  MAX_SKILLS,
  SKILL_ID_PATTERN,
  SkillRoleSchema,
  SkillSchema,
  type Skill,
  type SkillDraft,
  type SkillRole,
} from '@harness/protocol';
import { writeFileAtomic } from './settings/files';

/**
 * The War Room's skill shelf: one `<id>/SKILL.md` per skill in the app's data folder, in
 * the Agent Skills layout (so skills made for Claude Code can be dropped in). It lives
 * outside the workspace on purpose: agents can read skills but never write them, so a
 * file in a project can't rewrite the team's instructions.
 */

const SKILL_FILE = 'SKILL.md';
const ALL_ROLES: readonly SkillRole[] = SkillRoleSchema.options;
/** Extra headroom for the frontmatter on top of the body limit. */
const MAX_FILE_CHARS = MAX_SKILL_BODY + 2_000;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

/** A frontmatter value: JSON-quoted (what we write) or bare (what people type). */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Fall through to the bare value.
    }
  }
  return value.replace(/^'(.*)'$/, '$1');
}

/** Flat `key: value` lines only; enough for SKILL.md frontmatter, and unknown keys are ignored. */
function parseFrontmatter(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2]);
  }
  return fields;
}

/** Skills without a `roles` line (e.g. ones made for Claude Code) go to everyone. */
function parseRoles(raw: string | undefined): SkillRole[] {
  if (raw === undefined) return [...ALL_ROLES];
  const names = raw.replace(/^\s*\[|\]\s*$/g, '').split(',').map((part) => scalar(part).toLowerCase());
  const roles = ALL_ROLES.filter((role) => names.includes(role));
  return roles.length ? roles : [...ALL_ROLES];
}

/** Reads one SKILL.md; null when it isn't a usable skill (the reason goes to `warn`). */
export function parseSkill(id: string, text: string, warn: (why: string) => void = () => undefined): Skill | null {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    warn('it has no "---" frontmatter with a name and description');
    return null;
  }
  const fields = parseFrontmatter(match[1]);
  const enabled = fields.get('enabled');
  const parsed = SkillSchema.safeParse({
    id,
    name: scalar(fields.get('name') ?? id),
    description: scalar(fields.get('description') ?? ''),
    roles: parseRoles(fields.get('roles')),
    enabled: enabled === undefined || scalar(enabled).toLowerCase() !== 'false',
    body: match[2].replace(/^\r?\n/, ''),
  });
  if (!parsed.success) {
    warn(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    return null;
  }
  return parsed.data;
}

export function serializeSkill(skill: Skill): string {
  // Single-line values, JSON-quoted: valid YAML, and colons or "#" in a description stay text.
  const line = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim());
  const body = skill.body.endsWith('\n') || !skill.body ? skill.body : `${skill.body}\n`;
  return [
    '---',
    `name: ${line(skill.name)}`,
    `description: ${line(skill.description)}`,
    `roles: ${skill.roles.join(', ')}`,
    `enabled: ${skill.enabled}`,
    '---',
    body,
  ].join('\n');
}

/** A folder name from a skill's name: "Our Python style!" → "our-python-style". */
export function slugify(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'skill';
}

type Logger = Pick<Console, 'warn'>;

export class SkillStore {
  private readonly listeners = new Set<(skills: Skill[]) => void>();

  private constructor(readonly dir: string, private readonly log: Logger) {}

  static async open(dataDir: string, log: Logger = console): Promise<SkillStore> {
    const dir = path.join(dataDir, 'skills');
    await mkdir(dir, { recursive: true });
    return new SkillStore(dir, log);
  }

  /** Read from disk every time, so skills copied into the folder show up without a restart. */
  async list(): Promise<Skill[]> {
    const skills: Skill[] = [];
    for (const name of await this.folderNames()) {
      const text = await readFile(path.join(this.dir, name, SKILL_FILE), 'utf8').catch(() => null);
      if (text === null) continue;
      if (text.length > MAX_FILE_CHARS) {
        this.log.warn(`[skills] skipped ${name}: longer than ${MAX_SKILL_BODY} characters`);
        continue;
      }
      const skill = parseSkill(name, text, (why) => this.log.warn(`[skills] skipped ${name}: ${why}`));
      if (skill) skills.push(skill);
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
  }

  /** The enabled skills given to a role. */
  async forRole(role: SkillRole): Promise<Skill[]> {
    return (await this.list()).filter((skill) => skill.enabled && skill.roles.includes(role));
  }

  onChange(listener: (skills: Skill[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Creates (no id) or replaces a skill; returns it as saved. */
  async save(draft: SkillDraft): Promise<Skill> {
    const existing = await this.list();
    let id = draft.id;
    if (!id) {
      if (existing.length >= MAX_SKILLS) throw new SkillError(`The shelf is full (${MAX_SKILLS} skills). Delete one first.`);
      id = await this.freeId(slugify(draft.name));
    } else if (!existing.some((skill) => skill.id === id)) {
      throw new SkillError(`There is no skill "${id}". It may have been deleted.`);
    }
    const name = draft.name.trim().toLowerCase();
    const duplicate = existing.find((skill) => skill.id !== id && skill.name.toLowerCase() === name);
    if (duplicate) throw new SkillError(`There is already a skill called "${duplicate.name}".`);
    const skill = SkillSchema.parse({ ...draft, id });
    const folder = path.join(this.dir, id);
    await mkdir(folder, { recursive: true });
    await writeFileAtomic(path.join(folder, SKILL_FILE), serializeSkill(skill), 0o644);
    await this.notify();
    return skill;
  }

  /** Removes the SKILL.md, and its folder only if nothing else (scripts, examples) is in it. */
  async delete(id: string): Promise<void> {
    if (!(await this.list()).some((skill) => skill.id === id)) throw new SkillError(`There is no skill "${id}".`);
    const folder = path.join(this.dir, id);
    await rm(path.join(folder, SKILL_FILE));
    await rmdir(folder).catch(() => undefined);
    await this.notify();
  }

  private async folderNames(): Promise<string[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
  }

  /** Never reuses a folder that exists on disk, even one without a valid SKILL.md. */
  private async freeId(base: string): Promise<string> {
    const taken = new Set(await this.folderNames());
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async notify(): Promise<void> {
    const skills = await this.list();
    for (const listener of this.listeners) listener(skills);
  }
}
