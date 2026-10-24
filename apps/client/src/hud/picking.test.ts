import { describe, expect, it } from 'vitest';
import { pickActor, type ScreenActor } from './picking';

const standing = (id: string, x: number): ScreenActor => ({ id, foot: { x, y: 100 }, head: { x, y: 60 } });

describe('pickActor', () => {
  it('picks the character whose body is under the pointer', () => {
    expect(pickActor([standing('a', 50), standing('b', 150)], { x: 152, y: 80 }, 12)).toBe('b');
  });

  it('prefers the closest body when two overlap', () => {
    expect(pickActor([standing('a', 100), standing('b', 108)], { x: 106, y: 80 }, 12)).toBe('b');
  });

  it('returns null when the click misses everyone', () => {
    expect(pickActor([standing('a', 50)], { x: 200, y: 80 }, 12)).toBeNull();
  });

  it('measures to the body segment, not just its ends', () => {
    expect(pickActor([standing('a', 50)], { x: 60, y: 80 }, 12)).toBe('a');
    expect(pickActor([standing('a', 50)], { x: 50, y: 120 }, 12)).toBeNull();
  });
});
