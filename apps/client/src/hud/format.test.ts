import { describe, expect, it } from 'vitest';
import type { ChatLine, TaskInfo } from '../state/world';
import { conversationFor, formatAgo, formatCost, formatTokens, normalizeAnswer, normalizeGoal, tasksByColumn } from './format';

describe('formatCost', () => {
  it('marks simulated spend so it is never mistaken for a real bill', () => {
    expect(formatCost(1.234, true)).toBe('$1.23 SIM');
    expect(formatCost(0.5, false)).toBe('$0.50');
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatAgo', () => {
  it('shows seconds, then minutes, then hours', () => {
    expect(formatAgo(4_000)).toBe('4s');
    expect(formatAgo(125_000)).toBe('2m');
    expect(formatAgo(7_200_000)).toBe('2h');
    expect(formatAgo(-50)).toBe('0s');
  });
});

describe('tasksByColumn', () => {
  it('groups tasks by state, keeping creation order', () => {
    const tasks = new Map<string, TaskInfo>([
      ['t1', { id: 't1', title: 'A', state: 'done', agentId: null }],
      ['t2', { id: 't2', title: 'B', state: 'todo', agentId: null }],
      ['t3', { id: 't3', title: 'C', state: 'done', agentId: 'w1' }],
      ['t4', { id: 't4', title: 'D', state: 'failed', agentId: 'w1' }],
    ]);
    const columns = tasksByColumn(tasks);
    expect(columns.done.map((task) => task.id)).toEqual(['t1', 't3']);
    expect(columns.todo.map((task) => task.id)).toEqual(['t2']);
    expect(columns.doing).toEqual([]);
    expect(columns.failed.map((task) => task.id)).toEqual(['t4']);
  });
});

describe('conversationFor', () => {
  const line = (from: string, to: string, text: string): ChatLine => ({ from, to, text, ts: 0 });

  it('keeps only lines the agent sent or received, newest last, capped', () => {
    const lines = [line('a', 'b', '1'), line('c', 'd', '2'), line('b', 'a', '3'), line('a', 'c', '4')];
    expect(conversationFor(lines, 'a', 2).map((chat) => chat.text)).toEqual(['3', '4']);
  });
});

describe('normalizeGoal', () => {
  it('trims, rejects empty goals and caps very long ones', () => {
    expect(normalizeGoal('  Build a todo app ')).toBe('Build a todo app');
    expect(normalizeGoal('   ')).toBeNull();
    expect(normalizeGoal('x'.repeat(9_000))).toHaveLength(4_000);
  });
});

describe('normalizeAnswer', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeAnswer('  use   SQLite \n please ')).toBe('use SQLite please');
  });

  it('rejects empty answers', () => {
    expect(normalizeAnswer('   ')).toBeNull();
  });

  it('caps very long answers', () => {
    expect(normalizeAnswer('x'.repeat(5_000))).toHaveLength(2_000);
  });
});
