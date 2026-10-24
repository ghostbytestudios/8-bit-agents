import { Vector3, type Camera } from 'three';

export type NameTagRole = 'boss' | 'architect' | 'worker';

export interface NameTagTarget {
  name: string;
  role: NameTagRole;
  subtitle?: string;
  /** Writes the top of the character's head (world space) into `out`. */
  headPosition(out: Vector3): Vector3;
}

/** Gap between the top of the head and the bottom of the tag, in world units. */
const HEAD_CLEARANCE = 0.08;

interface Tag {
  target: NameTagTarget;
  root: HTMLElement;
  bubble: HTMLElement;
  icon: HTMLElement;
  steadyIcon: string;
  flashSecondsLeft: number;
  bubbleSecondsLeft: number;
}

/**
 * Everything floating over a character: name tag, status icon, and speech bubble.
 * Drawn as DOM over the canvas so text stays crisp at any zoom and is untouched by
 * the palette/outline post-processing. All text is set via textContent — names and
 * messages come from agents and must never be able to inject markup.
 */
export class NameTags {
  visible = true;
  /** Called when a name tag is clicked. */
  onSelect: ((id: string) => void) | null = null;

  private readonly layer: HTMLElement;
  private readonly tags = new Map<string, Tag>();
  private readonly scratch = new Vector3();

  constructor(parent: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'name-tags';
    parent.appendChild(this.layer);
  }

  add(id: string, target: NameTagTarget): void {
    const root = document.createElement('div');
    root.className = `actor-overlay actor-overlay--${target.role}`;

    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble';
    bubble.hidden = true;

    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'name-tag';
    tag.title = `Inspect ${target.name}`;
    tag.addEventListener('click', () => this.onSelect?.(id));
    const line = document.createElement('span');
    line.className = 'name-tag__line';
    const icon = document.createElement('span');
    icon.className = 'name-tag__icon';
    const name = document.createElement('span');
    name.textContent = target.name;
    line.append(icon, name);
    tag.appendChild(line);
    if (target.subtitle) {
      const subtitle = document.createElement('small');
      subtitle.textContent = target.subtitle;
      tag.appendChild(subtitle);
    }

    root.append(bubble, tag);
    this.layer.appendChild(root);
    this.tags.set(id, { target, root, bubble, icon, steadyIcon: '', flashSecondsLeft: 0, bubbleSecondsLeft: 0 });
  }

  /** Highlights one agent's tag (or none). */
  setSelected(id: string | null): void {
    for (const [tagId, tag] of this.tags) tag.root.classList.toggle('is-selected', tagId === id);
  }

  /** Icon that stays until changed (e.g. 💭 while thinking). Unknown ids are ignored. */
  setIcon(id: string, icon: string): void {
    const tag = this.tags.get(id);
    if (!tag) return;
    tag.steadyIcon = icon;
    if (tag.flashSecondsLeft <= 0) tag.icon.textContent = icon;
  }

  /** Icon shown briefly (e.g. ❌ when a command fails), then back to the steady icon. */
  flashIcon(id: string, icon: string, seconds: number): void {
    const tag = this.tags.get(id);
    if (!tag) return;
    tag.flashSecondsLeft = seconds;
    tag.icon.textContent = icon;
  }

  /** Speech bubble; `Infinity` keeps it up until the next `say`. */
  say(id: string, text: string, seconds: number): void {
    const tag = this.tags.get(id);
    if (!tag) return;
    tag.bubble.textContent = text;
    tag.bubble.hidden = text.length === 0;
    tag.bubbleSecondsLeft = seconds;
  }

  /** Re-projects every overlay onto the screen and ticks timers; call once per frame. */
  update(camera: Camera, canvas: HTMLCanvasElement, dt: number): void {
    this.layer.hidden = !this.visible;
    const rect = canvas.getBoundingClientRect();
    for (const tag of this.tags.values()) {
      this.tickTimers(tag, dt);
      if (!this.visible) continue;
      const point = tag.target.headPosition(this.scratch);
      point.y += HEAD_CLEARANCE;
      point.project(camera);
      const x = Math.round(rect.left + ((point.x + 1) / 2) * rect.width);
      const y = Math.round(rect.top + ((1 - point.y) / 2) * rect.height);
      tag.root.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
  }

  private tickTimers(tag: Tag, dt: number): void {
    if (tag.flashSecondsLeft > 0) {
      tag.flashSecondsLeft -= dt;
      if (tag.flashSecondsLeft <= 0) tag.icon.textContent = tag.steadyIcon;
    }
    if (tag.bubbleSecondsLeft > 0) {
      tag.bubbleSecondsLeft -= dt;
      if (tag.bubbleSecondsLeft <= 0) tag.bubble.hidden = true;
    }
  }
}
