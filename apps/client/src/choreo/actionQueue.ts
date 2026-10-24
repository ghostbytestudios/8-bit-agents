import type { CharacterPose } from '../actors/character';
import type { WorkPlace } from './behaviors';

/** Where a stage action happens: a work place, someone else's desk, your desk, or the break room. */
export type StagePlace = WorkPlace | 'home' | 'visit' | 'visitor' | 'break';

/** One beat of on-screen activity for an agent. */
export interface StageAction {
  /** Actions with the same key merge instead of queueing again (10 reads → one trip, ×10). */
  key: string;
  place: StagePlace;
  /** Agent being visited when `place` is 'visit'. */
  target?: string;
  pose?: CharacterPose;
  icon: string;
  label: string;
  holdSeconds: number;
  /** Jumps the queue and interrupts routine work (questions for you, errors). */
  priority: boolean;
  count: number;
  /** Hold until this human-input request is resolved. */
  untilResolved?: string;
}

/** More than this many pending beats means the animation is falling behind. */
export const MAX_QUEUED_ACTIONS = 4;

/**
 * Pure queue update: merges with the last queued beat when the key matches, puts
 * priority beats first, and when the queue overflows drops the oldest *routine*
 * beats (the HUD still shows exact history, so skipping animation is safe).
 */
export function enqueueAction(queue: readonly StageAction[], action: StageAction): StageAction[] {
  const last = queue.at(-1);
  if (last && last.key === action.key) {
    return [...queue.slice(0, -1), { ...last, count: last.count + action.count, label: action.label }];
  }
  const next = action.priority
    ? [...queue.filter((queued) => queued.priority), action, ...queue.filter((queued) => !queued.priority)]
    : [...queue, action];

  while (next.length > MAX_QUEUED_ACTIONS) {
    const oldestRoutine = next.findIndex((queued) => !queued.priority);
    if (oldestRoutine === -1) break;
    next.splice(oldestRoutine, 1);
  }
  return next;
}

/** Merge counts only read naturally for tool work ("Reading ×3"), not breaks or chats. */
const COUNTED_KEY_PREFIX = 'tool:';

export function formatLabel(action: Pick<StageAction, 'key' | 'label' | 'count'>, maxLength: number): string {
  const isCounted = action.key.startsWith(COUNTED_KEY_PREFIX) && action.count > 1;
  const suffix = isCounted ? ` ×${action.count}` : '';
  const room = maxLength - suffix.length;
  const text = action.label.length > room ? `${action.label.slice(0, room - 1)}…` : action.label;
  return text + suffix;
}
