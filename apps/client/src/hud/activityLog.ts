import type { WorldState } from '../state/world';
import { Region, el } from './dom';

const LOG_ICONS = { info: 'ℹ️', warn: '⚠️', error: '⚠️' } as const;
/** Within this many pixels of the bottom counts as "reading the latest". */
const STICK_TO_BOTTOM_PX = 24;

interface LogEntry {
  ts: number;
  kind: 'chat' | 'info' | 'warn' | 'error';
  who: string;
  text: string;
}

/** Every message between agents plus their logs, oldest first, like a chat transcript. */
export class ActivityLog {
  private readonly region = new Region(el('ol', 'activity-log'));

  get element(): HTMLElement {
    return this.region.element;
  }

  render(state: WorldState): void {
    const nameOf = (id: string) => state.agents.get(id)?.name ?? id.toUpperCase();
    const entries: LogEntry[] = [
      ...state.messages.map((line) => ({ ts: line.ts, kind: 'chat' as const, who: `${nameOf(line.from)} → ${nameOf(line.to)}`, text: line.text })),
      ...state.logs.map((line) => ({ ts: line.ts, kind: line.level, who: `${LOG_ICONS[line.level]} ${nameOf(line.agentId)}`, text: line.text })),
    ].sort((a, b) => a.ts - b.ts);

    const list = this.region.element;
    const isAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_TO_BOTTOM_PX;
    const last = entries.at(-1);
    this.region.render(`${entries.length}:${last?.ts ?? 0}:${state.runId}`, () => {
      if (!entries.length) return [el('li', 'panel__empty', 'Quiet so far.')];
      return entries.map((entry) => {
        const item = el('li', `activity-log__entry activity-log__entry--${entry.kind}`);
        item.append(el('span', 'activity-log__who', entry.who), el('span', '', entry.text));
        return item;
      });
    });
    if (isAtBottom) list.scrollTop = list.scrollHeight;
  }
}
