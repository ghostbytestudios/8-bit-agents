import type { AgentRole, HarnessEvent } from '@harness/protocol';
import type { Scene, Vector3 } from 'three';
import { Character, type CharacterLook } from '../actors/character';
import type { NameTagRole, NameTags } from '../hud/nameTags';
import type { WorldState } from '../state/world';
import type { Crowd } from '../world/crowd';
import type { SpotDef } from '../world/layout';
import { enqueueAction, formatLabel, type StageAction } from './actionQueue';
import { BREAK_SPOT_PREFIXES, PLACE_SPOT_PREFIXES, STATUS_ICONS, behaviorForTool } from './behaviors';

const SPAWN_INTERVAL_SECONDS = 1.1;
const TOOL_HOLD_SECONDS = 2.5;
const MESSAGE_HOLD_SECONDS = 3.5;
const BREAK_HOLD_SECONDS = 12;
const ERROR_HOLD_SECONDS = 2.5;
/** Extra time granted when a merged action repeats while it's already playing. */
const MERGE_EXTEND_SECONDS = 1.2;
const BUBBLE_SECONDS = 4;
const FLASH_SECONDS = 1.5;
const MAX_BUBBLE_CHARS = 64;

const TAG_ROLE: Record<AgentRole, NameTagRole> = {
  boss: 'boss', architect: 'architect', worker: 'worker', reviewer: 'worker', researcher: 'worker',
};
const FIXED_HOME: Partial<Record<AgentRole, string>> = { boss: 'boss', architect: 'whiteboard' };

const BOSS_LOOK: CharacterLook = { shirt: '#ffffff', pants: '#262b44', skin: '#e8b796', hair: '#3e2731', shoes: '#181425', tie: '#e43b44' };
const ARCHITECT_LOOK: CharacterLook = { shirt: '#124e89', pants: '#3a4466', skin: '#c28569', hair: '#181425', shoes: '#3e2731' };
const WORKER_SHIRTS = ['#63c74d', '#e43b44', '#feae34', '#0099db', '#b55088', '#f77622', '#2ce8f5', '#c0cbdc'];
const WORKER_HAIR = ['#b86f50', '#3e2731', '#181425', '#feae34', '#733e39', '#e4a672'];
const WORKER_SKIN = ['#e4a672', '#e8b796', '#c28569', '#b86f50', '#733e39'];
const WORKER_PANTS = ['#5a6988', '#262b44', '#3a4466', '#733e39'];

function workerLook(index: number): CharacterLook {
  const pick = (options: string[], salt: number) => options[(index * 7 + salt) % options.length];
  return {
    shirt: WORKER_SHIRTS[index % WORKER_SHIRTS.length],
    hair: pick(WORKER_HAIR, 1),
    skin: pick(WORKER_SKIN, 3),
    pants: pick(WORKER_PANTS, 2),
    shoes: '#262b44',
  };
}

interface Actor {
  id: string;
  role: AgentRole;
  name: string;
  character: Character;
  home: SpotDef;
  hasEntered: boolean;
  queue: StageAction[];
  current: StageAction | null;
  phase: 'idle' | 'moving' | 'holding';
  holdSecondsLeft: number;
  statusIcon: string;
}

export interface ChoreographerOptions {
  scene: Scene;
  crowd: Crowd;
  spots: ReadonlyMap<string, SpotDef>;
  overlay: NameTags;
  /** Where arriving agents walk in from (just outside the front door). */
  doorOutside: Vector3;
}

/**
 * Turns the event stream into a watchable office. Each agent has a small queue of
 * stage actions ("walk to the filing cabinets and read"); bursts merge, urgent
 * beats (questions for you, errors) jump the queue, and a long backlog is trimmed
 * — the HUD shows the exact truth, the office shows the gist.
 */
export class Choreographer {
  private readonly actors = new Map<string, Actor>();
  private readonly arrivals: Actor[] = [];
  private readonly entrance: SpotDef;
  private spawnTimer = 0;
  private workerCount = 0;

  constructor(private readonly options: ChoreographerOptions) {
    this.entrance = this.requireSpot('entrance');
  }

  get characters(): Iterable<Character> {
    return [...this.actors.values()].filter((actor) => actor.hasEntered).map((actor) => actor.character);
  }

  handle(event: HarnessEvent, world: WorldState): void {
    switch (event.type) {
      case 'agent.spawned':
        this.spawn(event.agentId, event.role, event.name);
        return;
      case 'agent.status':
        this.onStatus(event.agentId, event.status);
        return;
      case 'tool.started': {
        const behavior = behaviorForTool(event.tool);
        this.enqueue(event.agentId, {
          key: `tool:${behavior.place}:${event.tool}`,
          place: behavior.place,
          icon: behavior.icon,
          label: `${behavior.verb} ${event.summary}`,
          holdSeconds: TOOL_HOLD_SECONDS,
          priority: false,
          count: 1,
        });
        return;
      }
      case 'tool.finished':
        if (!event.ok) this.options.overlay.flashIcon(event.agentId, '❌', FLASH_SECONDS);
        return;
      case 'message.sent':
        this.enqueue(event.from, {
          key: `msg:${event.to}`,
          place: 'visit',
          target: event.to,
          icon: '💬',
          label: event.text,
          holdSeconds: MESSAGE_HOLD_SECONDS,
          priority: false,
          count: 1,
        });
        this.options.overlay.flashIcon(event.to, '💬', MESSAGE_HOLD_SECONDS);
        return;
      case 'task.assigned': {
        const title = world.tasks.get(event.taskId)?.title ?? 'New task';
        this.options.overlay.say(event.agentId, `📋 ${title}`, BUBBLE_SECONDS);
        return;
      }
      case 'plan.updated':
        this.options.overlay.flashIcon(event.agentId, '✏️', BUBBLE_SECONDS);
        this.options.overlay.say(event.agentId, 'Plan updated on the whiteboard', BUBBLE_SECONDS);
        return;
      case 'human.input_requested':
        this.enqueue(event.agentId, {
          key: `ask:${event.requestId}`,
          place: 'visitor',
          pose: 'raise',
          icon: '❗',
          label: event.prompt,
          holdSeconds: Infinity,
          priority: true,
          count: 1,
          untilResolved: event.requestId,
        });
        return;
      case 'human.input_resolved':
        this.onResolved(event.requestId, event.answer);
        return;
      case 'log':
        if (event.level === 'error') this.options.overlay.flashIcon(event.agentId, '⚠️', FLASH_SECONDS);
        return;
      case 'task.created':
      case 'task.updated':
      case 'usage':
        return;
    }
  }

  update(dt: number, time: number): void {
    this.admitArrivals(dt);
    for (const actor of this.actors.values()) {
      if (!actor.hasEntered) continue;
      this.step(actor, dt);
      actor.character.update(dt, time);
    }
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  private spawn(id: string, role: AgentRole, name: string): void {
    if (this.actors.has(id)) return;
    const home = this.pickHome(role);
    if (!home) {
      console.warn(`[choreo] no free desk for agent "${id}"; it will appear in the HUD only`);
      return;
    }
    const look = role === 'boss' ? BOSS_LOOK : role === 'architect' ? ARCHITECT_LOOK : workerLook(this.workerCount++);
    const actor: Actor = {
      id, role, name, home,
      character: new Character(look),
      hasEntered: false,
      queue: [],
      current: null,
      phase: 'idle',
      holdSecondsLeft: 0,
      statusIcon: '',
    };
    this.actors.set(id, actor);
    this.arrivals.push(actor);
  }

  private onStatus(id: string, status: keyof typeof STATUS_ICONS): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.statusIcon = STATUS_ICONS[status];
    if (actor.phase === 'idle') this.options.overlay.setIcon(id, actor.statusIcon);
    if (status === 'done') {
      this.enqueue(id, { key: 'break', place: 'break', icon: '☕', label: 'Done — coffee break!', holdSeconds: BREAK_HOLD_SECONDS, priority: false, count: 1 });
    } else if (status === 'error') {
      this.enqueue(id, { key: 'error', place: 'home', pose: 'puzzled', icon: '⚠️', label: 'Hmm, that broke…', holdSeconds: ERROR_HOLD_SECONDS, priority: true, count: 1 });
    }
  }

  private onResolved(requestId: string, answer: string): void {
    for (const actor of this.actors.values()) {
      actor.queue = actor.queue.filter((action) => action.untilResolved !== requestId);
      if (actor.current?.untilResolved !== requestId) continue;
      actor.holdSecondsLeft = 0;
      if (actor.phase === 'moving') {
        actor.current = null;
        actor.phase = 'idle';
      }
      this.options.overlay.say(actor.id, `👍 ${answer}`, BUBBLE_SECONDS);
    }
  }

  private enqueue(id: string, action: StageAction): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    const current = actor.current;
    if (current && current.key === action.key && actor.phase !== 'idle') {
      actor.current = { ...current, count: current.count + 1, label: action.label };
      if (actor.phase === 'holding') {
        actor.holdSecondsLeft = Math.max(actor.holdSecondsLeft, MERGE_EXTEND_SECONDS);
        this.options.overlay.say(id, formatLabel(actor.current, MAX_BUBBLE_CHARS), BUBBLE_SECONDS);
      }
      return;
    }
    actor.queue = enqueueAction(actor.queue, action);
    // Urgent beats interrupt routine work immediately.
    if (action.priority && current && !current.priority) {
      actor.current = null;
      actor.phase = 'idle';
    }
  }

  // ── Per-frame staging ──────────────────────────────────────────────────────

  /** Agents walk in through the front door one at a time. */
  private admitArrivals(dt: number): void {
    this.spawnTimer -= dt;
    const next = this.arrivals[0];
    if (!next || this.spawnTimer > 0 || !this.options.crowd.isTileFree(this.entrance.tile)) return;
    this.arrivals.shift();
    this.spawnTimer = SPAWN_INTERVAL_SECONDS;
    const { crowd, scene, overlay, doorOutside } = this.options;
    crowd.add(next.id, next.character, this.entrance.tile, next.home, doorOutside);
    scene.add(next.character.root);
    overlay.add(next.id, {
      name: next.name,
      role: TAG_ROLE[next.role],
      subtitle: next.role === 'boss' ? 'ORCHESTRATOR' : undefined,
      headPosition: (out) => next.character.headPosition(out),
    });
    overlay.setIcon(next.id, next.statusIcon);
    next.hasEntered = true;
  }

  private step(actor: Actor, dt: number): void {
    const { crowd, overlay } = this.options;
    switch (actor.phase) {
      case 'idle': {
        const next = actor.queue.shift();
        if (next) {
          this.begin(actor, next);
          return;
        }
        // Nothing to act out: drift back to the desk and show the status icon.
        if (crowd.isSettled(actor.id) && crowd.destinationOf(actor.id).id !== actor.home.id) {
          crowd.assign(actor.id, actor.home);
        }
        overlay.setIcon(actor.id, actor.statusIcon);
        return;
      }
      case 'moving':
        if (crowd.isSettled(actor.id) && actor.current) this.startHolding(actor, actor.current);
        return;
      case 'holding':
        actor.holdSecondsLeft -= dt;
        if (actor.holdSecondsLeft <= 0) {
          actor.current = null;
          actor.phase = 'idle';
        }
        return;
    }
  }

  private begin(actor: Actor, action: StageAction): void {
    actor.current = action;
    this.options.overlay.setIcon(actor.id, action.icon);
    const spot = this.spotFor(actor, action);
    if (!spot) {
      // Nowhere free to go: act it out on the spot.
      this.startHolding(actor, action);
      return;
    }
    this.options.crowd.assign(actor.id, spot, action.pose);
    actor.phase = 'moving';
  }

  private startHolding(actor: Actor, action: StageAction): void {
    actor.phase = 'holding';
    actor.holdSecondsLeft = action.holdSeconds;
    const bubbleSeconds = action.untilResolved ? Infinity : Math.min(BUBBLE_SECONDS, action.holdSeconds);
    this.options.overlay.say(actor.id, formatLabel(action, MAX_BUBBLE_CHARS), bubbleSeconds);
  }

  // ── Places ─────────────────────────────────────────────────────────────────

  private spotFor(actor: Actor, action: StageAction): SpotDef | null {
    switch (action.place) {
      case 'home':
      case 'desk':
        return actor.home;
      case 'cabinets':
      case 'library':
      case 'server':
      case 'printer':
        return this.privateSpot(actor, action.place)
          ?? this.freeSpot(actor, PLACE_SPOT_PREFIXES[action.place])
          ?? actor.home;
      case 'break':
        return this.freeSpot(actor, BREAK_SPOT_PREFIXES) ?? actor.home;
      case 'visitor':
        return this.freeSpot(actor, ['visitor:']) ?? actor.home;
      case 'visit': {
        const target = action.target ? this.actors.get(action.target) : undefined;
        if (!target?.hasEntered || target === actor) return null;
        const spot = this.options.spots.get(`visit:${target.home.id}`);
        return spot && this.options.crowd.isSpotFree(spot.id, actor.id) ? spot : null;
      }
    }
  }

  /** A spot reserved for this agent's home (e.g. `cabinets@boss`), if one exists and is free. */
  private privateSpot(actor: Actor, place: string): SpotDef | null {
    const spot = this.options.spots.get(`${place}@${actor.home.id}`);
    return spot && this.options.crowd.isSpotFree(spot.id, actor.id) ? spot : null;
  }

  /**
   * The closest unclaimed spot whose id starts with one of the prefixes, so a busy
   * set of cabinets sends people to the next-nearest set instead of across the office.
   */
  private freeSpot(actor: Actor, prefixes: readonly string[]): SpotDef | null {
    const { x, z } = actor.character.root.position;
    const distance = (spot: SpotDef) => Math.hypot(spot.anchor.x - x, spot.anchor.z - z);
    const free = [...this.options.spots.values()].filter((spot) =>
      prefixes.some((prefix) => spot.id.startsWith(prefix)) && this.options.crowd.isSpotFree(spot.id, actor.id),
    );
    return free.sort((a, b) => distance(a) - distance(b))[0] ?? null;
  }

  private pickHome(role: AgentRole): SpotDef | null {
    const fixed = FIXED_HOME[role];
    if (fixed) return this.requireSpot(fixed);
    const taken = new Set([...this.actors.values()].map((actor) => actor.home.id));
    return [...this.options.spots.values()].find((spot) => spot.kind === 'desk' && !taken.has(spot.id)) ?? null;
  }

  private requireSpot(id: string): SpotDef {
    const spot = this.options.spots.get(id);
    if (!spot) throw new Error(`Layout is missing spot "${id}"`);
    return spot;
  }
}
