import { Vector3, type Camera } from 'three';
import type { HotspotDef } from '../world/layout';

/** Gap between the top of the furniture and the bottom of the tag, in world units. */
const CLEARANCE = 0.12;
const ICONS: Readonly<Record<HotspotDef['id'], string>> = { files: '📁', skills: '📖' };

/**
 * Always-visible tags over the War Room's clickable furniture, styled like agents' name
 * tags. Without them nothing says the cabinet and shelf open anything, and touch screens
 * never see the hover label.
 */
export class HotspotLabels {
  private readonly layer = document.createElement('div');
  private readonly tags: Array<{ hotspot: HotspotDef; root: HTMLElement }> = [];
  private readonly scratch = new Vector3();

  constructor(parent: HTMLElement, hotspots: readonly HotspotDef[], onOpen: (hotspot: HotspotDef) => void) {
    this.layer.className = 'name-tags';
    for (const hotspot of hotspots) {
      const root = document.createElement('div');
      root.className = 'actor-overlay hotspot-label';
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'name-tag';
      tag.title = hotspot.id === 'files' ? 'Open the workspace files' : 'Open the skill shelf';
      const line = document.createElement('span');
      line.className = 'name-tag__line';
      const icon = document.createElement('span');
      icon.className = 'name-tag__icon';
      icon.textContent = ICONS[hotspot.id];
      const label = document.createElement('span');
      label.textContent = hotspot.label;
      line.append(icon, label);
      tag.append(line);
      tag.addEventListener('click', () => onOpen(hotspot));
      root.append(tag);
      this.layer.append(root);
      this.tags.push({ hotspot, root });
    }
    parent.append(this.layer);
  }

  /** Re-projects the tags onto the screen; call once per frame. */
  update(camera: Camera, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    for (const { hotspot, root } of this.tags) {
      const point = this.scratch.set(hotspot.at[0], hotspot.height + CLEARANCE, hotspot.at[1]).project(camera);
      const x = Math.round(rect.left + ((point.x + 1) / 2) * rect.width);
      const y = Math.round(rect.top + ((1 - point.y) / 2) * rect.height);
      root.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
  }
}
