import { describe, expect, it } from 'vitest';
import { MAX_QUEUED_ACTIONS, enqueueAction, formatLabel, type StageAction } from './actionQueue';

function action(key: string, overrides: Partial<StageAction> = {}): StageAction {
  return { key, place: 'desk', icon: '', label: key, holdSeconds: 1, priority: false, count: 1, ...overrides };
}

describe('enqueueAction', () => {
  it('merges consecutive actions with the same key and counts them', () => {
    const queue = [action('read'), action('read', { label: 'latest' })].reduce(enqueueAction, [] as StageAction[]);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ count: 2, label: 'latest' });
  });

  it('keeps different keys as separate beats in order', () => {
    const queue = [action('read'), action('write')].reduce(enqueueAction, [] as StageAction[]);
    expect(queue.map((a) => a.key)).toEqual(['read', 'write']);
  });

  it('puts priority actions ahead of routine ones but behind earlier priority ones', () => {
    const queue = [action('read'), action('ask-1', { priority: true }), action('ask-2', { priority: true })]
      .reduce(enqueueAction, [] as StageAction[]);
    expect(queue.map((a) => a.key)).toEqual(['ask-1', 'ask-2', 'read']);
  });

  it('drops the oldest routine actions when it overflows, never priority ones', () => {
    const keys = ['ask', 'a', 'b', 'c', 'd', 'e'];
    const queue = keys
      .map((key) => action(key, { priority: key === 'ask' }))
      .reduce(enqueueAction, [] as StageAction[]);
    expect(queue).toHaveLength(MAX_QUEUED_ACTIONS);
    expect(queue.map((a) => a.key)).toEqual(['ask', 'c', 'd', 'e']);
  });

  it('does not mutate the input queue', () => {
    const original = [action('read')];
    enqueueAction(original, action('write'));
    expect(original).toHaveLength(1);
  });
});

describe('formatLabel', () => {
  it('appends the merge count for tool work', () => {
    expect(formatLabel({ key: 'tool:cabinets:Read', label: 'Reading', count: 3 }, 40)).toBe('Reading ×3');
  });

  it('omits the count for non-tool beats like breaks', () => {
    expect(formatLabel({ key: 'break', label: 'Coffee break', count: 2 }, 40)).toBe('Coffee break');
  });

  it('truncates long labels with an ellipsis', () => {
    const label = formatLabel({ key: 'tool:desk:Write', label: 'x'.repeat(100), count: 1 }, 20);
    expect(label).toHaveLength(20);
    expect(label.endsWith('…')).toBe(true);
  });
});
