import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, writeFileAtomic } from '@harness/server/app';
import { z } from 'zod';

export interface ReleaseNotes {
  version: string;
  notes: readonly string[];
}

/** Newest first. Add an entry with every version bump; Help › What's New shows it. */
export const CHANGELOG: readonly ReleaseNotes[] = [
  {
    version: '0.2.0',
    notes: [
      "Click the filing cabinet in the War Room to browse your project's files, with what each agent read or wrote marked.",
      'A new skill shelf in the War Room: write skills that teach the team how you like things done.',
      'Give each skill to the Boss, the Architect or the Workers. Agents walk to the shelf to read one when it fits the work.',
      'Skills are SKILL.md files, so skills made for Claude Code can be copied in.',
    ],
  },
  {
    version: '0.1.0',
    notes: [
      'First beta of 8Bit Agents for Windows, macOS and Linux.',
      'A Boss, an Architect and Workers plan and build your goal in a pixel-art office.',
      'Use Claude, OpenAI, OpenRouter, Groq, or a local model through Ollama or LM Studio.',
      'API keys are encrypted with your system keychain and only ever sent to their provider.',
      'Shell commands wait for your OK in the inbox, and every run stops at your spending limit.',
    ],
  },
];

const LAST_VERSION_FILE = 'last-version.json';
const LastVersionSchema = z.object({ version: z.string().max(64) });

/** Compares dotted version numbers ("0.10.0" > "0.9.2"); anything after "-" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Notes from releases after `previous`, up to and including `current`. */
export function notesSince(changelog: readonly ReleaseNotes[], previous: string, current: string): ReleaseNotes[] {
  return changelog.filter(({ version }) => compareVersions(version, previous) > 0 && compareVersions(version, current) <= 0);
}

/** Notes for the version that is running (or the newest older one, if it has none of its own). */
export function notesFor(changelog: readonly ReleaseNotes[], current: string): ReleaseNotes | null {
  return changelog.find(({ version }) => compareVersions(version, current) <= 0) ?? null;
}

export function formatNotes(releases: readonly ReleaseNotes[]): string {
  return releases.map(({ version, notes }) => [`Version ${version}`, ...notes.map((note) => `• ${note}`)].join('\n')).join('\n\n');
}

/**
 * Remembers which version ran last and returns what changed since then. A fresh install
 * returns nothing: the welcome screen is enough.
 */
export async function takeUnseenNotes(dataDir: string, current: string, changelog = CHANGELOG): Promise<ReleaseNotes[]> {
  const file = path.join(dataDir, LAST_VERSION_FILE);
  const raw = await readFile(file, 'utf8').catch(() => null);
  const parsed = raw === null ? null : LastVersionSchema.safeParse(parseJson(raw));
  const previous = parsed?.success ? parsed.data.version : null;
  if (previous !== current) await writeFileAtomic(file, `${JSON.stringify({ version: current })}\n`);
  return previous === null ? [] : notesSince(changelog, previous, current);
}
