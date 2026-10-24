import { describe, expect, it } from 'vitest';
import { WalkGrid } from './walkGrid';

describe('WalkGrid', () => {
  it('finds a straight path across open floor', () => {
    const grid = new WalkGrid(5, 1);
    expect(grid.findPath({ x: 0, z: 0 }, { x: 4, z: 0 })).toHaveLength(5);
  });

  it('routes through a doorway instead of through a wall', () => {
    // Wall along x = 2 with a one-tile door at z = 2.
    const grid = new WalkGrid(4, 3);
    grid.addWallAlongZ(2, 0, 2);
    const path = grid.findPath({ x: 0, z: 0 }, { x: 3, z: 0 });
    expect(path).not.toBeNull();
    expect(path!.some((tile) => tile.z === 2)).toBe(true);
  });

  it('returns null when a wall fully separates two rooms', () => {
    const grid = new WalkGrid(4, 2);
    grid.addWallAlongZ(2, 0, 2);
    expect(grid.findPath({ x: 0, z: 0 }, { x: 3, z: 0 })).toBeNull();
  });

  it('never cuts a corner diagonally past a blocked tile', () => {
    const grid = new WalkGrid(2, 2);
    grid.block(1, 0);
    expect(grid.canMove(0, 0, 1, 1)).toBe(false);
    expect(grid.findPath({ x: 0, z: 0 }, { x: 1, z: 1 })).toEqual([{ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }]);
  });

  it('can route around tiles rejected by a filter (occupied by others)', () => {
    const grid = new WalkGrid(3, 3);
    const occupied = (x: number, z: number) => !(x === 1 && z === 1);
    const path = grid.findPath({ x: 0, z: 1 }, { x: 2, z: 1 }, occupied);
    expect(path).not.toBeNull();
    expect(path!.some((tile) => tile.x === 1 && tile.z === 1)).toBe(false);
  });

  it('finds the nearest walkable tile next to a blocked one', () => {
    const grid = new WalkGrid(3, 1);
    grid.block(0, 0);
    expect(grid.nearestWalkable({ x: 0, z: 0 })).toEqual({ x: 1, z: 0 });
  });
});
