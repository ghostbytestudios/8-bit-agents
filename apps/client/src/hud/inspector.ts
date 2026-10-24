import { STATUS_ICONS } from '../choreo/behaviors';
import type { AgentInfo, WorldState } from '../state/world';
import { Region, button, el } from './dom';
import { conversationFor, formatCost, formatTokens } from './format';

const CHAT_LINES = 5;
const TOOL_MARKS = { running: '…', ok: '✓', failed: '✗' } as const;

export interface InspectorHandlers {
  onClose(): void;
  onToggleFollow(): void;
  onOpenInbox(): void;
}

interface InspectorView {
  stats: Array<[label: string, value: string]>;
  waiting: string | null;
  tools: string[];
  plan: string | null;
  chat: string[];
}

/** Everything known about one agent, straight from the world store (exact, not the animation). */
export class Inspector {
  readonly element = el('section', 'panel inspector');
  private readonly title = el('h2', 'panel__title');
  private readonly subtitle = el('p', 'inspector__subtitle');
  private readonly followButton: HTMLButtonElement;
  private readonly body = new Region(el('div', 'inspector__body'));
  private agentId: string | null = null;

  constructor(private readonly handlers: InspectorHandlers, private readonly isSimulated: boolean) {
    this.followButton = button('pixel-button', 'FOLLOW', () => handlers.onToggleFollow());
    const close = button('pixel-button pixel-button--icon', '✕', () => handlers.onClose());
    close.setAttribute('aria-label', 'Close inspector');
    const header = el('header', 'panel__header');
    const heading = el('div', 'inspector__heading');
    heading.append(this.title, this.subtitle);
    header.append(heading, this.followButton, close);
    this.element.append(header, this.body.element);
    this.element.hidden = true;
  }

  get selected(): string | null {
    return this.agentId;
  }

  show(agentId: string | null): void {
    this.agentId = agentId;
    this.element.hidden = agentId === null;
  }

  /** Cheap to call every frame; only touches the DOM when the state flips. */
  setFollowing(isFollowing: boolean): void {
    if (this.followButton.getAttribute('aria-pressed') === String(isFollowing)) return;
    this.followButton.textContent = isFollowing ? 'UNFOLLOW' : 'FOLLOW';
    this.followButton.setAttribute('aria-pressed', String(isFollowing));
  }

  render(state: WorldState): void {
    if (!this.agentId) return;
    const agent = state.agents.get(this.agentId);
    if (!agent) {
      this.title.textContent = 'AGENT LEFT';
      this.subtitle.textContent = '';
      this.body.render('gone', () => [el('p', 'panel__empty', 'This agent is no longer in the run.')]);
      return;
    }
    this.element.dataset.role = agent.role;
    this.title.textContent = agent.name;
    this.subtitle.textContent = `${agent.role.toUpperCase()} · ${agent.model}`;
    const view = this.viewOf(agent, state);
    this.body.render(JSON.stringify(view), () => this.build(view));
  }

  private viewOf(agent: AgentInfo, state: WorldState): InspectorView {
    const nameOf = (id: string) => state.agents.get(id)?.name ?? id.toUpperCase();
    const waiting = [...state.inbox.values()].find((request) => request.agentId === agent.id);
    return {
      stats: [
        ['STATUS', `${STATUS_ICONS[agent.status]} ${agent.status.toUpperCase()}`.trim()],
        ['DOING', agent.currentTool ?? '—'],
        ['TASK', (agent.taskId && state.tasks.get(agent.taskId)?.title) || '—'],
        ['TOKENS', formatTokens(agent.tokens)],
        ['COST', formatCost(agent.costUsd, this.isSimulated)],
      ],
      waiting: waiting?.prompt ?? null,
      tools: agent.recentTools.map((call) => `${TOOL_MARKS[call.state]} ${call.tool} ${call.summary}`),
      plan: state.plan?.agentId === agent.id ? state.plan.markdown : null,
      chat: conversationFor(state.messages, agent.id, CHAT_LINES).map((line) =>
        line.from === agent.id ? `TO ${nameOf(line.to)}: ${line.text}` : `${nameOf(line.from)}: ${line.text}`,
      ),
    };
  }

  private build(view: InspectorView): Node[] {
    const stats = el('dl', 'stats');
    for (const [label, value] of view.stats) stats.append(el('dt', '', label), el('dd', '', value));
    const nodes: Node[] = [stats];
    if (view.waiting) {
      const card = el('div', 'inspector__waiting');
      card.append(el('p', '', `❗ ${view.waiting}`), button('pixel-button', 'ANSWER', () => this.handlers.onOpenInbox()));
      nodes.push(card);
    }
    nodes.push(...section('RECENT TOOLS', view.tools, 'No tool calls yet.'));
    if (view.plan) nodes.push(...section('PLAN', [view.plan], ''));
    nodes.push(...section('CONVERSATION', view.chat, 'Nobody has talked to this agent yet.'));
    return nodes;
  }
}

function section(title: string, lines: readonly string[], emptyText: string): Node[] {
  const list = el('ul', 'line-list');
  for (const line of lines) list.append(el('li', '', line));
  return [el('h3', 'panel__subtitle', title), lines.length ? list : el('p', 'panel__empty', emptyText)];
}
