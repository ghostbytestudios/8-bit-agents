import type { AgentStatus } from '@harness/protocol';

/**
 * How agent activity looks in the office. Kept as data so new tools (or harness
 * plugins later) only add a row here.
 */
export type WorkPlace = 'desk' | 'cabinets' | 'library' | 'server' | 'printer';

/** Where the work happens; the spot itself decides the pose (stand at shelves, sit in reading chairs). */
export interface ToolBehavior {
  place: WorkPlace;
  icon: string;
  verb: string;
}

const TOOL_RULES: ReadonlyArray<{ match: RegExp; behavior: ToolBehavior }> = [
  { match: /^(Write|Edit|MultiEdit|NotebookEdit|TodoWrite)$/, behavior: { place: 'desk', icon: '⌨️', verb: 'Writing' } },
  { match: /^(Read|Grep|Glob|LS)$/, behavior: { place: 'cabinets', icon: '📁', verb: 'Reading' } },
  { match: /^(WebSearch|WebFetch)$/, behavior: { place: 'library', icon: '🔎', verb: 'Researching' } },
  { match: /^(Bash|PowerShell)$/, behavior: { place: 'server', icon: '⚙️', verb: 'Running' } },
  { match: /^mcp__/, behavior: { place: 'desk', icon: '🔌', verb: 'Using' } },
];

/** Anything unrecognized: "using a gadget at their desk". Never breaks the game. */
const FALLBACK: ToolBehavior = { place: 'desk', icon: '🛠️', verb: 'Using' };

export function behaviorForTool(tool: string): ToolBehavior {
  return TOOL_RULES.find((rule) => rule.match.test(tool))?.behavior ?? FALLBACK;
}

/** Spot-id prefixes for each shared work place (see world/layout.ts). */
export const PLACE_SPOT_PREFIXES: Record<Exclude<WorkPlace, 'desk'>, readonly string[]> = {
  cabinets: ['cabinets:'],
  library: ['library:'],
  server: ['server:'],
  printer: ['printer'],
};

export const BREAK_SPOT_PREFIXES: readonly string[] = ['sofa:', 'break:', 'coffee'];

/** Icon shown over an agent idling at its desk. */
export const STATUS_ICONS: Record<AgentStatus, string> = {
  idle: '',
  thinking: '💭',
  working: '',
  blocked: '❗',
  done: '✅',
  error: '⚠️',
};
