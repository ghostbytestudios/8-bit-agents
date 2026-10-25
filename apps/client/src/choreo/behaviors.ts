import type { AgentStatus } from '@harness/protocol';

/**
 * How agent activity looks in the office. Kept as data so new tools (or harness
 * plugins later) only add a row here.
 */
export type WorkPlace = 'desk' | 'cabinets' | 'library' | 'server' | 'printer' | 'skills';

/** Where the work happens; the spot itself decides the pose (stand at shelves, sit in reading chairs). */
export interface ToolBehavior {
  place: WorkPlace;
  icon: string;
  verb: string;
}

// Claude Code's tool names, plus the harness server's own agent tools (snake_case).
const TOOL_RULES: ReadonlyArray<{ match: RegExp; behavior: ToolBehavior }> = [
  { match: /^(Write|Edit|MultiEdit|NotebookEdit|TodoWrite|write_file)$/, behavior: { place: 'desk', icon: '⌨️', verb: 'Writing' } },
  { match: /^(write_plan)$/, behavior: { place: 'desk', icon: '✏️', verb: 'Drawing' } },
  { match: /^(create_tasks|complete_task|finish_run)$/, behavior: { place: 'desk', icon: '📋', verb: 'Filing' } },
  { match: /^(Read|Grep|Glob|LS|read_file|list_files)$/, behavior: { place: 'cabinets', icon: '📁', verb: 'Reading' } },
  { match: /^(read_skill|Skill)$/, behavior: { place: 'skills', icon: '📖', verb: 'Studying' } },
  { match: /^(WebSearch|WebFetch)$/, behavior: { place: 'library', icon: '🔎', verb: 'Researching' } },
  { match: /^(Bash|PowerShell|run_command)$/, behavior: { place: 'server', icon: '⚙️', verb: 'Running' } },
  { match: /^(ask_human|ask_architect|answer)$/, behavior: { place: 'desk', icon: '💬', verb: 'Asking' } },
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
  skills: ['skills:'],
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
