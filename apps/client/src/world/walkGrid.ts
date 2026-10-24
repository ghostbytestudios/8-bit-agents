export interface Tile {
  x: number;
  z: number;
}

export type TileFilter = (x: number, z: number) => boolean;

const CARDINALS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONALS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALWAYS: TileFilter = () => true;

/**
 * Tile grid of walkable floor. Furniture blocks whole tiles; walls sit on the
 * edges *between* tiles, so a wall never eats a row of floor.
 * 8-directional A* that never cuts a corner past a wall or obstacle.
 */
export class WalkGrid {
  private readonly blocked: Uint8Array;
  /** Index `z * width + x` blocks moving between (x, z - 1) and (x, z). */
  private readonly wallsAlongX: Uint8Array;
  /** Index `z * (width + 1) + x` blocks moving between (x - 1, z) and (x, z). */
  private readonly wallsAlongZ: Uint8Array;

  constructor(readonly width: number, readonly depth: number) {
    this.blocked = new Uint8Array(width * depth);
    this.wallsAlongX = new Uint8Array(width * (depth + 1));
    this.wallsAlongZ = new Uint8Array((width + 1) * depth);
  }

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.width && z < this.depth;
  }

  block(x: number, z: number): void {
    if (this.inBounds(x, z)) this.blocked[z * this.width + x] = 1;
  }

  isWalkable(x: number, z: number): boolean {
    return this.inBounds(x, z) && this.blocked[z * this.width + x] === 0;
  }

  /** Wall running along x on grid line `z`, covering every tile it overlaps in [from, to). */
  addWallAlongX(z: number, from: number, to: number): void {
    if (z < 0 || z > this.depth) return;
    for (let x = Math.max(0, Math.floor(from)); x < Math.min(this.width, Math.ceil(to)); x++) {
      this.wallsAlongX[z * this.width + x] = 1;
    }
  }

  /** Wall running along z on grid line `x`, covering every tile it overlaps in [from, to). */
  addWallAlongZ(x: number, from: number, to: number): void {
    if (x < 0 || x > this.width) return;
    for (let z = Math.max(0, Math.floor(from)); z < Math.min(this.depth, Math.ceil(to)); z++) {
      this.wallsAlongZ[z * (this.width + 1) + x] = 1;
    }
  }

  /** Single cardinal step: target must be walkable and no wall on the shared edge. */
  private canStep(x: number, z: number, dx: number, dz: number): boolean {
    if (!this.isWalkable(x + dx, z + dz)) return false;
    if (dx === 1) return this.wallsAlongZ[z * (this.width + 1) + x + 1] === 0;
    if (dx === -1) return this.wallsAlongZ[z * (this.width + 1) + x] === 0;
    if (dz === 1) return this.wallsAlongX[(z + 1) * this.width + x] === 0;
    return this.wallsAlongX[z * this.width + x] === 0;
  }

  /** Diagonals are only allowed when both L-shaped routes around the corner are open. */
  canMove(x: number, z: number, dx: number, dz: number): boolean {
    if (dx === 0 || dz === 0) return this.canStep(x, z, dx, dz);
    return (
      this.canStep(x, z, dx, 0) && this.canStep(x + dx, z, 0, dz) &&
      this.canStep(x, z, 0, dz) && this.canStep(x, z + dz, dx, 0)
    );
  }

  /** Breadth-first search outward for the closest walkable tile that passes `isFree`. */
  nearestWalkable(from: Tile, isFree: TileFilter = ALWAYS): Tile | null {
    if (!this.inBounds(from.x, from.z)) return null;
    const seen = new Uint8Array(this.width * this.depth);
    const queue: Tile[] = [from];
    seen[from.z * this.width + from.x] = 1;
    while (queue.length) {
      const tile = queue.shift()!;
      if (this.isWalkable(tile.x, tile.z) && isFree(tile.x, tile.z)) return tile;
      for (const [dx, dz] of CARDINALS) {
        const next = { x: tile.x + dx, z: tile.z + dz };
        const index = next.z * this.width + next.x;
        if (this.inBounds(next.x, next.z) && !seen[index]) {
          seen[index] = 1;
          queue.push(next);
        }
      }
    }
    return null;
  }

  /**
   * A* from `start` to `goal`. `isPassable` lets callers route around tiles that are
   * temporarily taken (e.g. by other characters); the goal itself is always allowed.
   */
  findPath(start: Tile, goal: Tile, isPassable: TileFilter = ALWAYS): Tile[] | null {
    if (!this.isWalkable(goal.x, goal.z)) return null;
    const size = this.width * this.depth;
    const key = (x: number, z: number) => z * this.width + x;
    const cost = new Float32Array(size).fill(Infinity);
    const estimate = new Float32Array(size).fill(Infinity);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const open = new Set<number>([key(start.x, start.z)]);
    const heuristic = (x: number, z: number) => {
      const dx = Math.abs(x - goal.x);
      const dz = Math.abs(z - goal.z);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    cost[key(start.x, start.z)] = 0;
    estimate[key(start.x, start.z)] = heuristic(start.x, start.z);

    while (open.size) {
      let current = -1;
      for (const candidate of open) {
        if (current === -1 || estimate[candidate] < estimate[current]) current = candidate;
      }
      const cx = current % this.width;
      const cz = Math.floor(current / this.width);
      if (cx === goal.x && cz === goal.z) return this.reconstruct(cameFrom, current);
      open.delete(current);
      closed[current] = 1;

      for (const [dx, dz, stepCost] of [
        ...CARDINALS.map(([x, z]) => [x, z, 1] as const),
        ...DIAGONALS.map(([x, z]) => [x, z, Math.SQRT2] as const),
      ]) {
        const nx = cx + dx;
        const nz = cz + dz;
        const next = key(nx, nz);
        if (!this.canMove(cx, cz, dx, dz) || closed[next]) continue;
        const isGoal = nx === goal.x && nz === goal.z;
        if (!isGoal && !isPassable(nx, nz)) continue;
        const tentative = cost[current] + stepCost;
        if (tentative >= cost[next]) continue;
        cameFrom[next] = current;
        cost[next] = tentative;
        estimate[next] = tentative + heuristic(nx, nz);
        open.add(next);
      }
    }
    return null;
  }

  private reconstruct(cameFrom: Int32Array, end: number): Tile[] {
    const path: Tile[] = [];
    for (let node = end; node !== -1; node = cameFrom[node]) {
      path.push({ x: node % this.width, z: Math.floor(node / this.width) });
    }
    return path.reverse();
  }
}
