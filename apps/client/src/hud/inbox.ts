import type { InboxRequest, WorldState } from '../state/world';
import { button, el } from './dom';
import { MAX_ANSWER_CHARS, formatAgo, normalizeAnswer } from './format';

export interface InboxHandlers {
  onRespond(requestId: string, answer: string): void;
  onSelectAgent(agentId: string): void;
}

interface Card {
  root: HTMLElement;
  age: HTMLElement;
  controls: HTMLButtonElement[];
}

const KIND_LABEL = { question: 'QUESTION', approval: 'APPROVAL', choice: 'CHOICE' } as const;

/**
 * Questions and approvals waiting on you. Cards are keyed by request id and only
 * added or removed, never rebuilt, so a half-typed answer survives new events.
 */
export class InboxPanel {
  readonly element = el('div', 'inbox');
  private readonly empty = el('p', 'panel__empty', 'Nothing waiting on you. The office has it handled.');
  private readonly cards = new Map<string, Card>();

  constructor(private readonly handlers: InboxHandlers) {
    this.element.append(this.empty);
  }

  render(state: WorldState, now: number): void {
    for (const [requestId, card] of this.cards) {
      if (state.inbox.has(requestId)) continue;
      card.root.remove();
      this.cards.delete(requestId);
    }
    for (const request of state.inbox.values()) {
      const card = this.cards.get(request.requestId) ?? this.addCard(request, state);
      card.age.textContent = `${formatAgo(now - request.requestedAt)} AGO`;
    }
    this.empty.hidden = this.cards.size > 0;
  }

  /** Puts keyboard focus on the oldest question's first control. */
  focusFirst(): void {
    this.cards.values().next().value?.controls[0]?.focus();
  }

  private addCard(request: InboxRequest, state: WorldState): Card {
    const root = el('article', 'inbox-card');
    root.dataset.kind = request.kind;
    const asker = state.agents.get(request.agentId)?.name ?? request.agentId.toUpperCase();
    const header = el('header', 'inbox-card__header');
    const age = el('span', 'inbox-card__age');
    header.append(
      button('link-button', asker, () => this.handlers.onSelectAgent(request.agentId)),
      el('span', 'inbox-card__kind', KIND_LABEL[request.kind]),
      age,
    );
    root.append(header, el('p', 'inbox-card__prompt', request.prompt));

    const controls: HTMLButtonElement[] = [];
    const send = (answer: string) => {
      controls.forEach((control) => (control.disabled = true));
      root.classList.add('is-sending');
      this.handlers.onRespond(request.requestId, answer);
    };
    const options = el('div', 'inbox-card__options');
    for (const option of request.options) {
      const choice = button('pixel-button', option, () => send(option));
      controls.push(choice);
      options.append(choice);
    }
    if (request.options.length) root.append(options);
    if (request.kind !== 'approval' || request.options.length === 0) root.append(this.freeTextForm(send, controls));

    this.element.append(root);
    const card = { root, age, controls };
    this.cards.set(request.requestId, card);
    return card;
  }

  private freeTextForm(send: (answer: string) => void, controls: HTMLButtonElement[]): HTMLFormElement {
    const form = el('form', 'inbox-card__form');
    const input = el('input', 'pixel-input');
    input.type = 'text';
    input.maxLength = MAX_ANSWER_CHARS;
    input.placeholder = 'Type an answer…';
    input.setAttribute('aria-label', 'Your answer');
    const submit = el('button', 'pixel-button', 'SEND');
    submit.type = 'submit';
    controls.push(submit);
    form.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const answer = normalizeAnswer(input.value);
      if (!answer) {
        input.focus();
        return;
      }
      input.disabled = true;
      send(answer);
    });
    return form;
  }
}
