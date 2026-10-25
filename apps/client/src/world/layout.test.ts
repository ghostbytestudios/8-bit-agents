import { describe, expect, it } from 'vitest';
import { PLACE_SPOT_PREFIXES } from '../choreo/behaviors';
import { FURNITURE, HOTSPOTS, OFFICE_DEPTH, OFFICE_WIDTH, PROPS, ROOMS, SPOTS, WALLS } from './layout';
import { WalkGrid } from './walkGrid';
import { blockWalls } from './walls';

/** The same grid the office builds: walls, then every furniture and prop footprint. */
function officeGrid(): WalkGrid {
  const grid = new WalkGrid(OFFICE_WIDTH, OFFICE_DEPTH);
  blockWalls(grid, WALLS);
  for (const item of [...FURNITURE, ...PROPS]) {
    for (const [x, z] of item.blocks ?? []) grid.block(x, z);
  }
  return grid;
}

describe('office layout', () => {
  it('lets someone walk from the front door to every spot', () => {
    const grid = officeGrid();
    const entrance = SPOTS.find((candidate) => candidate.id === 'entrance');
    if (!entrance) throw new Error('no entrance spot');
    const unreachable = SPOTS.filter((candidate) => !grid.findPath(entrance.tile, candidate.tile)).map((candidate) => candidate.id);
    expect(unreachable).toEqual([]);
  });

  it('has somewhere to stand for every shared work place, the skill shelf included', () => {
    for (const [place, prefixes] of Object.entries(PLACE_SPOT_PREFIXES)) {
      expect(SPOTS.some((candidate) => prefixes.some((prefix) => candidate.id.startsWith(prefix))), place).toBe(true);
    }
  });

  it('keeps the file cabinet and skill shelf in the War Room', () => {
    const war = ROOMS.find((room) => room.id === 'war');
    if (!war) throw new Error('no War Room');
    const [x0, z0, x1, z1] = war.rect;
    for (const hotspot of HOTSPOTS) {
      const [x, z] = hotspot.at;
      expect(x >= x0 && x <= x1 && z >= z0 && z <= z1, hotspot.id).toBe(true);
    }
  });
});
