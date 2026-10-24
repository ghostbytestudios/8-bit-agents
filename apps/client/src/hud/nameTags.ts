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
  element: HTMLElement;
}

/**
 * Floating name labels drawn as DOM over the canvas, so text stays crisp at any
 * zoom and is untouched by the palette/outline post-processing.
 * Names are set via textContent — agent-provided names can never inject markup.
 */
export class NameTags {
  visible = true;

  private readonly layer: HTMLElement;
  private readonly tags: Tag[] = [];
  private readonly scratch = new Vector3();

  constructor(parent: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'name-tags';
    parent.appendChild(this.layer);
  }

  add(target: NameTagTarget): void {
    const element = document.createElement('div');
    element.className = `name-tag name-tag--${target.role}`;
    const name = document.createElement('span');
    name.textContent = target.name;
    element.appendChild(name);
    if (target.subtitle) {
      const subtitle = document.createElement('small');
      subtitle.textContent = target.subtitle;
      element.appendChild(subtitle);
    }
    this.layer.appendChild(element);
    this.tags.push({ target, element });
  }

  /** Re-projects every tag onto the screen; call once per frame after characters move. */
  update(camera: Camera, canvas: HTMLCanvasElement): void {
    this.layer.hidden = !this.visible;
    if (!this.visible) return;
    const rect = canvas.getBoundingClientRect();
    for (const { target, element } of this.tags) {
      const point = target.headPosition(this.scratch);
      point.y += HEAD_CLEARANCE;
      point.project(camera);
      const x = Math.round(rect.left + ((point.x + 1) / 2) * rect.width);
      const y = Math.round(rect.top + ((1 - point.y) / 2) * rect.height);
      element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
  }
}
