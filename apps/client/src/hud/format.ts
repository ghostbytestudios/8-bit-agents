import type { TaskState } from '@harness/protocol';
import type { ChatLine, TaskInfo } from '../state/world';

/** Longest answer the inbox will send; well under the protocol's text limit. */
export const MAX_ANSWER_CHARS = 2_000;

export const TASK_COLUMNS: readonly TaskState[] = ['todo', 'doing', 'review', 'done', 'failed'];

export function formatCost(usd: number, isSimulated: boolean): string {
  return `$${usd.toFixed(2)}${isSimulated ? ' SIM' : ''}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function formatAgo(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function tasksByColumn(tasks: ReadonlyMap<string, TaskInfo>): Record<TaskState, TaskInfo[]> {
  const columns = Object.fromEntries(TASK_COLUMNS.map((state) => [state, [] as TaskInfo[]])) as Record<TaskState, TaskInfo[]>;
  for (const task of tasks.values()) columns[task.state].push(task);
  return columns;
}

export function conversationFor(messages: readonly ChatLine[], agentId: string, limit: number): ChatLine[] {
  return messages.filter((line) => line.from === agentId || line.to === agentId).slice(-limit);
}

/** Longest goal the top bar accepts; well under the protocol's text limit. */
export const MAX_GOAL_CHARS = 4_000;

/** Cleans up a typed goal; null means there is nothing to start. */
export function normalizeGoal(raw: string): string | null {
  const goal = raw.trim().slice(0, MAX_GOAL_CHARS);
  return goal.length > 0 ? goal : null;
}

/** Cleans up a typed answer; null means there is nothing worth sending. */
export function normalizeAnswer(raw: string): string | null {
  const answer = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_CHARS);
  return answer.length > 0 ? answer : null;
}
