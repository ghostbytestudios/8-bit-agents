export interface ScreenPoint {
  x: number;
  y: number;
}

/** A character projected to the screen: a vertical-ish segment from feet to head. */
export interface ScreenActor {
  id: string;
  foot: ScreenPoint;
  head: ScreenPoint;
}

function distanceToSegment(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Which character a click landed on: the one whose body (feet→head) is nearest the
 * pointer, if it's within `radius` screen pixels. Screen-space, so it works the same
 * at every zoom level and needs no meshes to raycast against.
 */
export function pickActor(actors: readonly ScreenActor[], point: ScreenPoint, radius: number): string | null {
  let best: string | null = null;
  let bestDistance = radius;
  for (const actor of actors) {
    const distance = distanceToSegment(point, actor.foot, actor.head);
    if (distance <= bestDistance) {
      best = actor.id;
      bestDistance = distance;
    }
  }
  return best;
}
