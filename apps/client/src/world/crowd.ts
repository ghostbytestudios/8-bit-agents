import { Vector3 } from 'three';
import type { Character, CharacterPose } from '../actors/character';
import type { SpotDef } from './layout';
import type { Tile, WalkGrid } from './walkGrid';

const RETRY_UNREACHABLE_SECONDS = 1;
/** Waiting this long behind someone triggers a re-route around occupied tiles. */
const REPATH_AFTER_SECONDS = 1;
/** Waiting this long means we're stuck: head home instead. */
const GIVE_UP_AFTER_SECONDS = 3.5;
/** Tiles reserved ahead of a walking character (beyond the one it stands on). */
const LOOKAHEAD_TILES = 2;

interface CrowdAgent {
  id: string;
  character: Character;
  home: SpotDef;
  destination: SpotDef;
  poseOverride: CharacterPose | null;
  state: 'walking' | 'settled' | 'retrying';
  /** Tiles still to visit that haven't been reserved yet. */
  path: Tile[];
  /** trail[0] is the tile the agent occupies; the rest are reserved and queued as waypoints. */
  trail: Tile[];
  isApproachingAnchor: boolean;
  retryTimer: number;
  waitTimer: number;
  hasRepathed: boolean;
}

const tileKey = (x: number, z: number) => `${x},${z}`;
const tileCenter = (tile: Tile) => new Vector3(tile.x + 0.5, 0, tile.z + 0.5);

/**
 * Moves characters to the spots they're sent to without overlapping: each agent
 * reserves the tiles it stands on and is about to enter, waits when someone is in
 * the way, re-routes if the wait drags on, and heads home if it's truly stuck.
 * Where agents go is decided elsewhere (the Choreographer).
 */
export class Crowd {
  private readonly agents = new Map<string, CrowdAgent>();
  private readonly reservations = new Map<string, string>();
  private readonly claimedSpots = new Map<string, string>();

  constructor(private readonly grid: WalkGrid) {}

  isTileFree(tile: Tile): boolean {
    return !this.reservations.has(tileKey(tile.x, tile.z));
  }

  isSpotFree(spotId: string, agentId?: string): boolean {
    const owner = this.claimedSpots.get(spotId);
    return !owner || owner === agentId;
  }

  /**
   * Adds an agent standing on `start` and sends it home. With `enterFrom`, the
   * character first walks in from that point (e.g. outside the front door).
   */
  add(id: string, character: Character, start: Tile, home: SpotDef, enterFrom?: Vector3): void {
    const agent: CrowdAgent = {
      id, character, home,
      destination: home,
      poseOverride: null,
      state: 'walking',
      path: [],
      trail: [start],
      isApproachingAnchor: false,
      retryTimer: 0,
      waitTimer: 0,
      hasRepathed: false,
    };
    this.reservations.set(tileKey(start.x, start.z), id);
    this.claimedSpots.set(home.id, id);
    character.stand(enterFrom ?? tileCenter(start), Math.PI);
    if (enterFrom) character.appendWaypoint(tileCenter(start));
    this.agents.set(id, agent);
    this.goTo(agent, home);
  }

  /** Send an agent to a spot; `pose` overrides the spot's own pose on arrival. */
  assign(id: string, spot: SpotDef, pose?: CharacterPose): void {
    const agent = this.require(id);
    agent.poseOverride = pose ?? null;
    this.goTo(agent, spot);
  }

  /** True once the agent has arrived and struck its pose. */
  isSettled(id: string): boolean {
    return this.require(id).state === 'settled';
  }

  destinationOf(id: string): SpotDef {
    return this.require(id).destination;
  }

  update(dt: number): void {
    for (const agent of this.agents.values()) {
      if (agent.state === 'retrying') {
        agent.retryTimer -= dt;
        if (agent.retryTimer <= 0) this.goTo(agent, agent.destination);
      } else if (agent.state === 'walking') {
        this.updateWalking(agent, dt);
      }
    }
  }

  private require(id: string): CrowdAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Crowd has no agent "${id}"`);
    return agent;
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
      agent.poseOverride = null;
      this.goTo(agent, agent.home);
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
      // Unreachable right now (e.g. boxed in); wait a moment and try again.
      agent.state = 'retrying';
      agent.retryTimer = RETRY_UNREACHABLE_SECONDS;
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
    agent.state = 'settled';
    agent.character.settle(agent.poseOverride ?? spot.pose, spot.heading, spot.seatHeight);
  }
}
