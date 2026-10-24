import { BoxGeometry, Color, Group, Mesh, MeshLambertMaterial } from 'three';
import { loadModel } from './assets';
import type { WallDef, WallStyle } from './layout';
import type { WalkGrid } from './walkGrid';

const TALL_WALL_THICKNESS = 0.05;

interface CutawayLook {
  height: number;
  thickness: number;
  body: string;
  cap: string;
}

/** Interior and front walls are drawn "cut away" (Sims-style) so they never hide anyone. */
const CUTAWAY: Record<Exclude<WallStyle, 'tall'>, CutawayLook> = {
  low: { height: 0.3, thickness: 0.08, body: '#8b9bb4', cap: '#c0cbdc' },
  partition: { height: 0.42, thickness: 0.05, body: '#5a6988', cap: '#c0cbdc' },
};
const CAP_HEIGHT = 0.03;

const materials = new Map<string, MeshLambertMaterial>();
function material(color: string): MeshLambertMaterial {
  let shared = materials.get(color);
  if (!shared) {
    shared = new MeshLambertMaterial({ color: new Color(color) });
    materials.set(color, shared);
  }
  return shared;
}

/** Splits [from, to) into the solid stretches between door openings. */
function solidSpans(wall: WallDef): Array<[number, number]> {
  const doors = [...(wall.doors ?? [])].sort((a, b) => a[0] - b[0]);
  const spans: Array<[number, number]> = [];
  let cursor = wall.from;
  for (const [doorStart, doorEnd] of doors) {
    if (doorStart > cursor) spans.push([cursor, doorStart]);
    cursor = Math.max(cursor, doorEnd);
  }
  if (cursor < wall.to) spans.push([cursor, wall.to]);
  return spans;
}

function isInDoor(wall: WallDef, index: number): boolean {
  return (wall.doors ?? []).some(([start, end]) => index >= start && index < end);
}

/** Tall exterior walls use Kenney wall/window pieces, one per tile, pushed just outside the line. */
async function buildTallWall(wall: WallDef, group: Group): Promise<void> {
  const pieces: Array<Promise<void>> = [];
  for (let index = Math.floor(wall.from); index < Math.ceil(wall.to); index++) {
    if (isInDoor(wall, index)) continue;
    const name = wall.windows?.includes(index) ? 'wallWindow' : 'wall';
    pieces.push(loadModel(name).then((piece) => {
      if (wall.axis === 'x') {
        piece.position.set(index + 0.5, 0, wall.line - TALL_WALL_THICKNESS / 2);
      } else {
        piece.position.set(wall.line - TALL_WALL_THICKNESS / 2, 0, index + 0.5);
        piece.rotation.y = Math.PI / 2;
      }
      group.add(piece);
    }));
  }
  await Promise.all(pieces);
}

function buildCutawayWall(wall: WallDef, look: CutawayLook, group: Group): void {
  for (const [start, end] of solidSpans(wall)) {
    const length = end - start;
    const center = (start + end) / 2;
    const segment = new Group();
    const body = new Mesh(new BoxGeometry(length, look.height, look.thickness), material(look.body));
    body.position.y = look.height / 2;
    const cap = new Mesh(new BoxGeometry(length + 0.01, CAP_HEIGHT, look.thickness + 0.02), material(look.cap));
    cap.position.y = look.height + CAP_HEIGHT / 2;
    for (const mesh of [body, cap]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      segment.add(mesh);
    }
    if (wall.axis === 'x') {
      segment.position.set(center, 0, wall.line);
    } else {
      segment.position.set(wall.line, 0, center);
      segment.rotation.y = Math.PI / 2;
    }
    group.add(segment);
  }
}

export async function buildWalls(walls: readonly WallDef[]): Promise<Group> {
  const group = new Group();
  group.name = 'walls';
  await Promise.all(walls.map(async (wall) => {
    if (wall.style === 'tall') await buildTallWall(wall, group);
    else buildCutawayWall(wall, CUTAWAY[wall.style], group);
  }));
  return group;
}

export function blockWalls(grid: WalkGrid, walls: readonly WallDef[]): void {
  for (const wall of walls) {
    for (const [start, end] of solidSpans(wall)) {
      if (wall.axis === 'x') grid.addWallAlongX(wall.line, start, end);
      else grid.addWallAlongZ(wall.line, start, end);
    }
  }
}
