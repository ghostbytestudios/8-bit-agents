import { Vector3 } from 'three';
import type { Character } from '../actors/character';
import type { SpotDef } from './layout';
import type { Tile, WalkGrid } from './walkGrid';

const HOME_STAY_SECONDS: Range = [8, 16];
const ACTIVITY_STAY_SECONDS: Range = [4, 9];
const RETRY_UNREACHABLE_SECONDS = 1;
/** Waiting this long behind someone triggers a re-route around occupied tiles. */
const REPATH_AFTER_SECONDS = 1;
/** Waiting this long means we're stuck: pick a different destination. */
const GIVE_UP_AFTER_SECONDS = 3.5;
/** Tiles reserved ahead of a walking character (beyond the one it stands on). */
const LOOKAHEAD_TILES = 2;

type Range = readonly [min: number, max: number];

interface CrowdAgent {
  id: string;
  character: Character;
  home: SpotDef;
  destination: SpotDef;
  state: 'walking' | 'atSpot';
  /** Tiles still to visit that haven't been reserved yet. */
  path: Tile[];
  /** trail[0] is the tile the agent occupies; the rest are reserved and queued as waypoints. */
  trail: Tile[];
  isApproachingAnchor: boolean;
  stayTimer: number;
  waitTimer: number;
  hasRepathed: boolean;
}

const tileKey = (x: number, z: number) => `${x},${z}`;
const tileCenter = (tile: Tile) => new Vector3(tile.x + 0.5, 0, tile.z + 0.5);
const randomIn = ([min, max]: Range) => min + Math.random() * (max - min);

/**
 * Moves characters between named spots on the walk grid without overlapping:
 * each agent reserves the tiles it stands on and is about to enter, waits when
 * someone is in the way, re-routes if the wait drags on, and gives up on a
 * destination if it's truly stuck.
 */
export class Crowd {
  private readonly agents: CrowdAgent[] = [];
  private readonly reservations = new Map<string, string>();
  private readonly claimedSpots = new Map<string, string>();

  constructor(private readonly grid: WalkGrid, private readonly activitySpots: readonly SpotDef[]) {}

  /** Permanently reserve a tile for someone the crowd doesn't move (Boss, Architect). */
  reserveStatic(tile: Tile, ownerId: string): void {
    this.reservations.set(tileKey(tile.x, tile.z), ownerId);
  }

  isTileFree(tile: Tile): boolean {
    return !this.reservations.has(tileKey(tile.x, tile.z));
  }

  /**
   * Adds an agent standing on `start`. With `enterFrom`, the character first walks
   * in from that point (e.g. outside the front door).
   */
  add(id: string, character: Character, start: Tile, home: SpotDef, enterFrom?: Vector3): void {
    const agent: CrowdAgent = {
      id, character, home,
      destination: home,
      state: 'walking',
      path: [],
      trail: [start],
      isApproachingAnchor: false,
      stayTimer: 0,
      waitTimer: 0,
      hasRepathed: false,
    };
    this.reservations.set(tileKey(start.x, start.z), id);
    this.claimedSpots.set(home.id, id);
    character.stand(enterFrom ?? tileCenter(start), Math.PI);
    if (enterFrom) character.appendWaypoint(tileCenter(start));
    this.agents.push(agent);
    this.goTo(agent, home);
  }

  update(dt: number): void {
    for (const agent of this.agents) {
      if (agent.state === 'atSpot') this.updateAtSpot(agent, dt);
      else this.updateWalking(agent, dt);
    }
  }

  private updateAtSpot(agent: CrowdAgent, dt: number): void {
    agent.stayTimer -= dt;
    if (agent.stayTimer <= 0) this.goTo(agent, this.pickNextSpot(agent));
  }

  private updateWalking(agent: CrowdAgent, dt: number): void {
    this.releasePassedTiles(agent);
    if (agent.isApproachingAnchor) {
      if (agent.character.waypointCount === 0) this.arrive(agent);
      return;
    }
    this.reserveAhead(agent, dt);
    const isOnGoalTile = agent.path.length === 0 && agent.trail.length === 1;
    if (isOnGoalTile && agent.character.waypointCount === 0) {
      const { anchor } = agent.destination;
      agent.isApproachingAnchor = true;
      agent.character.appendWaypoint(new Vector3(anchor.x, 0, anchor.z));
    }
  }

  /** Frees tiles the character has walked past (one per waypoint it has reached). */
  private releasePassedTiles(agent: CrowdAgent): void {
    const queuedTiles = agent.trail.length - 1;
    const pendingWaypoints = agent.character.waypointCount - (agent.isApproachingAnchor ? 1 : 0);
    let reached = queuedTiles - Math.max(0, pendingWaypoints);
    while (reached > 0 && agent.trail.length > 1) {
      const left = agent.trail.shift()!;
      const key = tileKey(left.x, left.z);
      if (this.reservations.get(key) === agent.id) this.reservations.delete(key);
      reached--;
    }
  }

  private reserveAhead(agent: CrowdAgent, dt: number): void {
    while (agent.path.length && agent.trail.length - 1 < LOOKAHEAD_TILES) {
      const next = agent.path[0];
      const owner = this.reservations.get(tileKey(next.x, next.z));
      if (owner && owner !== agent.id) {
        this.handleBlocked(agent, dt);
        return;
      }
      this.reservations.set(tileKey(next.x, next.z), agent.id);
      agent.trail.push(agent.path.shift()!);
      agent.character.appendWaypoint(tileCenter(next));
      agent.waitTimer = 0;
      agent.hasRepathed = false;
    }
  }

  private handleBlocked(agent: CrowdAgent, dt: number): void {
    const isStandingStill = agent.trail.length === 1 && agent.character.waypointCount === 0;
    if (!isStandingStill) return;
    agent.waitTimer += dt;
    if (agent.waitTimer > GIVE_UP_AFTER_SECONDS) {
      const fallback = agent.destination === agent.home ? agent.home : this.pickActivity(agent) ?? agent.home;
      this.goTo(agent, fallback);
    } else if (agent.waitTimer > REPATH_AFTER_SECONDS && !agent.hasRepathed) {
      agent.hasRepathed = true;
      const detour = this.findPath(agent, agent.destination, true);
      if (detour) agent.path = detour;
    }
  }

  private goTo(agent: CrowdAgent, spot: SpotDef): void {
    if (agent.destination !== agent.home && agent.destination.id !== spot.id) {
      this.claimedSpots.delete(agent.destination.id);
    }
    this.claimedSpots.set(spot.id, agent.id);
    agent.destination = spot;
    agent.isApproachingAnchor = false;
    agent.waitTimer = 0;
    agent.hasRepathed = false;

    const path = this.findPath(agent, spot, false);
    if (!path) {
      // Unreachable right now (e.g. boxed in); idle briefly and try again.
      agent.state = 'atSpot';
      agent.stayTimer = RETRY_UNREACHABLE_SECONDS;
      return;
    }
    agent.path = path;
    agent.state = 'walking';
  }

  private findPath(agent: CrowdAgent, spot: SpotDef, avoidOthers: boolean): Tile[] | null {
    const here = agent.trail[agent.trail.length - 1];
    const isPassable = (x: number, z: number) => {
      const owner = this.reservations.get(tileKey(x, z));
      return !avoidOthers || !owner || owner === agent.id;
    };
    const path = this.grid.findPath(here, spot.tile, isPassable);
    return path ? path.slice(1) : null;
  }

  private arrive(agent: CrowdAgent): void {
    const spot = agent.destination;
    agent.isApproachingAnchor = false;
    agent.state = 'atSpot';
    agent.stayTimer = randomIn(spot === agent.home ? HOME_STAY_SECONDS : ACTIVITY_STAY_SECONDS);
    agent.character.settle(spot.pose, spot.heading, spot.seatHeight);
  }

  private pickNextSpot(agent: CrowdAgent): SpotDef {
    if (agent.destination !== agent.home) return agent.home;
    return this.pickActivity(agent) ?? agent.home;
  }

  private pickActivity(agent: CrowdAgent): SpotDef | null {
    const free = this.activitySpots.filter((spot) => {
      const owner = this.claimedSpots.get(spot.id);
      return !owner || owner === agent.id;
    });
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }
}
