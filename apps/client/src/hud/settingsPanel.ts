import {
  AppSettingsSchema,
  PROVIDER_PRESETS,
  type AppSettings,
  type HarnessCommand,
  type KeyStatus,
  type ProviderPreset,
  type ProviderSettings,
  type TeamMember,
} from '@harness/protocol';
import type { ProviderTestResult, SettingsSnapshot } from '../net/socketFeed';
import { button, el } from './dom';

/**
 * The Settings screen: providers and keys, who runs each role, the team's names and
 * colors, the look of the HUD, and run limits. Keys are write-only: they go to the local
 * server once and only "key set ••••1234" ever comes back.
 */

type Tab = 'models' | 'team' | 'look' | 'limits';
type RoleKey = keyof AppSettings['roles'];

const TABS: ReadonlyArray<[Tab, string]> = [['models', 'MODELS'], ['team', 'TEAM'], ['look', 'LOOK'], ['limits', 'LIMITS']];
const ROLES: ReadonlyArray<[RoleKey, string]> = [['boss', 'BOSS'], ['architect', 'ARCHITECT'], ['worker', 'WORKERS']];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const HUD_THEMES: ReadonlyArray<[AppSettings['appearance']['hudTheme'], string]> = [['night', 'Night'], ['day', 'Day'], ['contrast', 'High contrast']];
const MAX_WORKERS = 8;

export interface SettingsPanelHandlers {
  /** Sends a command to the local server; false when disconnected. */
  send(command: HarnessCommand): boolean;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrapper = el('label', 'settings-field');
  wrapper.append(el('span', 'settings-field__label', label), control);
  if (hint) wrapper.append(el('span', 'settings-field__hint', hint));
  return wrapper;
}

function select<T extends string>(options: ReadonlyArray<[T, string]>, value: T, onChange: (value: T) => void): HTMLSelectElement {
  const element = el('select', 'pixel-input');
  for (const [optionValue, label] of options) {
    const option = el('option', '', label);
    option.value = optionValue;
    element.append(option);
  }
  element.value = value;
  element.addEventListener('change', () => onChange(element.value as T));
  return element;
}

function textInput(value: string, maxLength: number, onInput: (value: string) => void, type = 'text'): HTMLInputElement {
  const input = el('input', 'pixel-input');
  input.type = type;
  input.value = value;
  input.maxLength = maxLength;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function numberInput(value: number, min: number, max: number, step: number, onInput: (value: number) => void): HTMLInputElement {
  const input = el('input', 'pixel-input');
  input.type = 'number';
  Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener('input', () => {
    if (input.value !== '' && Number.isFinite(input.valueAsNumber)) onInput(input.valueAsNumber);
  });
  return input;
}

function colorInput(value: string, onInput: (value: string) => void): HTMLInputElement {
  const input = el('input', 'settings-color');
  input.type = 'color';
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const wrapper = el('label', 'settings-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrapper.append(input, el('span', '', label));
  return wrapper;
}

export class SettingsPanel {
  private readonly backdrop = el('div', 'settings-backdrop');
  private readonly dialog = el('section', 'panel settings');
  private readonly body = el('div', 'settings__body');
  private readonly notice = el('p', 'settings__notice');
  private readonly saveButton: HTMLButtonElement;
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly tests = new Map<string, ProviderTestResult | 'testing'>();
  private tab: Tab = 'models';
  private saved: AppSettings | null = null;
  private draft: AppSettings | null = null;
  private keys: KeyStatus = {};
  private returnFocus: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly handlers: SettingsPanelHandlers) {
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', 'settings-title');
    const title = el('h2', 'panel__title', 'SETTINGS');
    title.id = 'settings-title';
    const close = button('pixel-button pixel-button--icon', '✕', () => this.close());
    close.setAttribute('aria-label', 'Close settings');
    const header = el('header', 'panel__header');
    header.append(title, close);

    const tabs = el('div', 'tab-list settings__tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [tab, label] of TABS) {
      const tabButton = button('tab', label, () => this.showTab(tab));
      tabButton.setAttribute('role', 'tab');
      tabs.append(tabButton);
      this.tabButtons.set(tab, tabButton);
    }

    this.saveButton = button('pixel-button', 'SAVE', () => this.save());
    const footer = el('footer', 'settings__footer');
    footer.append(this.notice, button('pixel-button', 'CANCEL', () => this.close()), this.saveButton);

    this.dialog.append(header, tabs, this.body, footer);
    this.backdrop.append(this.dialog);
    this.backdrop.hidden = true;
    // Clicking the dimmed area outside the dialog closes it.
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.close();
    });
    // Focusable so focus has somewhere to go when SAVE disables itself.
    this.dialog.tabIndex = -1;
    this.dialog.addEventListener('keydown', (event) => {
      event.stopPropagation(); // Office shortcuts stay off while Settings is open.
      if (event.key === 'Escape') this.close();
    });
    parent.append(this.backdrop);
  }

  get isOpen(): boolean {
    return !this.backdrop.hidden;
  }

  open(): void {
    if (!this.saved) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.draft = structuredClone(this.saved);
    this.setNotice('');
    this.backdrop.hidden = false;
    this.render();
    this.tabButtons.get(this.tab)?.focus();
  }

  close(): void {
    this.backdrop.hidden = true;
    this.draft = null;
    this.returnFocus?.focus();
  }

  setSettings(snapshot: SettingsSnapshot): void {
    const wasSaving = this.draft !== null && JSON.stringify(this.draft) === JSON.stringify(snapshot.settings);
    this.saved = snapshot.settings;
    this.keys = snapshot.keys;
    if (wasSaving) this.setNotice('Saved. Changes apply from the next run.', 'ok');
    if (this.isOpen) this.render();
  }

  showTest(result: ProviderTestResult): void {
    this.tests.set(result.providerId, result);
    if (this.isOpen && this.tab === 'models') this.render();
  }

  showError(text: string): void {
    if (this.isOpen) this.setNotice(text, 'error');
  }

  private get isDirty(): boolean {
    return this.draft !== null && JSON.stringify(this.draft) !== JSON.stringify(this.saved);
  }

  /** Applies an edit to the draft; `rerender` for edits that change what's on screen. */
  private edit(change: (draft: AppSettings) => void, rerender = false): void {
    if (!this.draft) return;
    change(this.draft);
    this.saveButton.disabled = !this.isDirty;
    if (rerender) this.render();
  }

  private showTab(tab: Tab): void {
    this.tab = tab;
    this.render();
  }

  private save(): void {
    if (!this.draft) return;
    const parsed = AppSettingsSchema.safeParse(this.draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.setNotice(`${issue.path.join(' › ')}: ${issue.message}`, 'error');
      return;
    }
    if (!this.handlers.send({ type: 'settings.update', settings: parsed.data })) {
      this.setNotice('Not connected to the Harness server.', 'error');
      return;
    }
    this.setNotice('Saving…');
    this.dialog.focus();
  }

  private setNotice(text: string, kind: 'ok' | 'error' | '' = ''): void {
    this.notice.textContent = text;
    this.notice.dataset.kind = kind;
  }

  private render(): void {
    if (!this.draft) return;
    for (const [tab, tabButton] of this.tabButtons) tabButton.setAttribute('aria-selected', String(tab === this.tab));
    this.saveButton.disabled = !this.isDirty;
    const draft = this.draft;
    const sections = { models: () => this.models(draft), team: () => this.team(draft), look: () => this.look(draft), limits: () => this.limits(draft) };
    this.body.replaceChildren(...sections[this.tab]());
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  private models(draft: AppSettings): Node[] {
    const providers = draft.providers.map((provider) => this.providerCard(draft, provider));
    const presetPicker = select(
      (Object.keys(PROVIDER_PRESETS) as ProviderPreset[]).map((preset) => [preset, PROVIDER_PRESETS[preset].label]),
      'openai',
      () => undefined,
    );
    presetPicker.setAttribute('aria-label', 'Provider type to add');
    const add = button('pixel-button', 'ADD PROVIDER', () => this.edit((next) => {
      const preset = presetPicker.value as ProviderPreset;
      let id: string = preset;
      for (let suffix = 2; next.providers.some((provider) => provider.id === id); suffix++) id = `${preset}-${suffix}`;
      const added: ProviderSettings = { id, preset, label: PROVIDER_PRESETS[preset].label };
      next.providers.push(preset === 'custom' ? { ...added, baseUrl: 'http://127.0.0.1:8080/v1' } : added);
    }, true));
    const addRow = el('div', 'settings-row');
    addRow.append(presetPicker, add);

    const roles = ROLES.map(([role, label]) => this.roleRow(draft, role, label));
    return [
      el('h3', 'panel__subtitle', 'PROVIDERS'),
      ...providers,
      addRow,
      el('h3', 'panel__subtitle', 'WHO RUNS EACH ROLE'),
      ...roles,
    ];
  }

  private providerCard(draft: AppSettings, provider: ProviderSettings): HTMLElement {
    const info = PROVIDER_PRESETS[provider.preset];
    const isSaved = this.saved?.providers.some((saved) => saved.id === provider.id) ?? false;
    const card = el('article', 'settings-card');
    const header = el('div', 'settings-row');
    const name = textInput(provider.label, 40, (value) => this.edit(() => (provider.label = value)));
    name.setAttribute('aria-label', 'Provider name');
    header.append(name, el('span', 'settings-field__hint', info.label));
    if (draft.providers.length > 1) {
      const remove = button('pixel-button pixel-button--icon', '✕', () => this.edit((next) => {
        next.providers = next.providers.filter((candidate) => candidate.id !== provider.id);
      }, true));
      remove.setAttribute('aria-label', `Remove ${provider.label}`);
      header.append(remove);
    }
    card.append(header);

    if (provider.preset === 'custom') {
      card.append(field('URL', textInput(provider.baseUrl ?? '', 300, (value) => this.edit(() => (provider.baseUrl = value))), 'An OpenAI-compatible /v1 endpoint'));
    }
    if (!isSaved) {
      card.append(el('p', 'settings-field__hint', 'Save settings to add a key and test this provider.'));
      return card;
    }
    card.append(this.keyRow(provider, info.needsKey, info.keyUrl), this.testRow(provider));
    return card;
  }

  private keyRow(provider: ProviderSettings, needsKey: boolean, keyUrl: string | null): HTMLElement {
    const status = this.keys[provider.id];
    const row = el('div', 'settings-row');
    const label = status?.isSet ? `KEY SET ••••${status.last4 ?? ''}` : needsKey ? 'NO KEY' : 'NO KEY (OPTIONAL)';
    row.append(el('span', `settings-key ${status?.isSet ? 'is-set' : ''}`, label));
    const input = textInput('', 500, () => undefined, 'password');
    input.placeholder = 'Paste API key';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `API key for ${provider.label}`);
    const saveKey = button('pixel-button', 'SAVE KEY', () => {
      const key = input.value.trim();
      if (key.length < 8) {
        this.setNotice('That key looks too short.', 'error');
        return;
      }
      input.value = '';
      if (!this.handlers.send({ type: 'provider.setKey', providerId: provider.id, key })) this.setNotice('Not connected to the Harness server.', 'error');
    });
    row.append(input, saveKey);
    if (status?.isSet) row.append(button('pixel-button', 'CLEAR', () => this.handlers.send({ type: 'provider.clearKey', providerId: provider.id })));
    if (keyUrl) {
      const link = el('a', 'link-button', 'GET A KEY');
      link.href = keyUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
    }
    return row;
  }

  private testRow(provider: ProviderSettings): HTMLElement {
    const row = el('div', 'settings-row');
    row.append(button('pixel-button', 'TEST CONNECTION', () => {
      if (!this.handlers.send({ type: 'provider.test', providerId: provider.id })) return;
      this.tests.set(provider.id, 'testing');
      this.render();
    }));
    const result = this.tests.get(provider.id);
    if (result === 'testing') row.append(el('span', 'settings-field__hint', 'TESTING…'));
    else if (result) row.append(el('span', `settings-test ${result.ok ? 'is-ok' : 'is-error'}`, `${result.ok ? '✓' : '✗'} ${result.detail}`));
    return row;
  }

  private roleRow(draft: AppSettings, role: RoleKey, label: string): HTMLElement {
    const config = draft.roles[role];
    const row = el('div', 'settings-row settings-role');
    row.append(el('span', 'settings-role__name', label));
    const providerPicker = select(draft.providers.map((provider) => [provider.id, provider.label]), config.provider, (value) => this.edit(() => (config.provider = value), true));
    providerPicker.setAttribute('aria-label', `${label} provider`);
    row.append(providerPicker);

    const provider = draft.providers.find((candidate) => candidate.id === config.provider);
    const model = textInput(config.model, 128, (value) => this.edit(() => (config.model = value.trim())));
    model.setAttribute('aria-label', `${label} model`);
    const listId = `models-${role}`;
    model.setAttribute('list', listId);
    const suggestions = el('datalist');
    suggestions.id = listId;
    const tested = provider ? this.tests.get(provider.id) : undefined;
    const known = new Set([...(provider ? PROVIDER_PRESETS[provider.preset].models : []), ...(tested && tested !== 'testing' ? tested.models : [])]);
    for (const id of known) {
      const option = el('option');
      option.value = id;
      suggestions.append(option);
    }
    row.append(model, suggestions);

    if (provider && PROVIDER_PRESETS[provider.preset].kind === 'anthropic') {
      const effort = select([['', 'default'], ...EFFORTS.map((level): [string, string] => [level, level])], config.effort ?? '', (value) =>
        this.edit(() => {
          if (value) config.effort = value as (typeof EFFORTS)[number];
          else delete config.effort;
        }));
      effort.setAttribute('aria-label', `${label} effort`);
      row.append(effort);
    }
    return row;
  }

  private team(draft: AppSettings): Node[] {
    const team = draft.team;
    const count = select(
      Array.from({ length: MAX_WORKERS }, (_, index): [string, string] => [String(index + 1), String(index + 1)]),
      String(team.workers),
      (value) => this.edit(() => (team.workers = Number(value)), true),
    );
    const member = (label: string, person: TeamMember) => {
      const row = el('div', 'settings-row settings-member');
      const name = textInput(person.name, 20, (value) => this.edit(() => (person.name = value.trim() || label)));
      name.setAttribute('aria-label', `${label} name`);
      const shirt = colorInput(person.shirt, (value) => this.edit(() => (person.shirt = value)));
      shirt.setAttribute('aria-label', `${label} shirt color`);
      const hair = colorInput(person.hair, (value) => this.edit(() => (person.hair = value)));
      hair.setAttribute('aria-label', `${label} hair color`);
      row.append(el('span', 'settings-role__name', label), name, el('span', 'settings-field__hint', 'SHIRT'), shirt, el('span', 'settings-field__hint', 'HAIR'), hair);
      return row;
    };
    return [
      field('WORKERS', count, 'How many workers sit in the office during a run.'),
      el('h3', 'panel__subtitle', 'NAMES & COLORS'),
      member('BOSS', team.boss),
      member('ARCHITECT', team.architect),
      ...team.workerLooks.slice(0, team.workers).map((person, index) => member(`WORKER ${index + 1}`, person)),
    ];
  }

  private look(draft: AppSettings): Node[] {
    const look = draft.appearance;
    return [
      field('HUD THEME', select(HUD_THEMES, look.hudTheme, (value) => this.edit(() => (look.hudTheme = value)))),
      field('ACCENT COLOR', colorInput(look.accent, (value) => this.edit(() => (look.accent = value)))),
      field('DEFAULT ZOOM', select([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], String(look.zoom), (value) => this.edit(() => (look.zoom = Number(value))))),
      el('h3', 'panel__subtitle', 'PIXEL EFFECTS'),
      checkbox('Retro palette', look.palette, (checked) => this.edit(() => (look.palette = checked))),
      checkbox('Dithering', look.dither, (checked) => this.edit(() => (look.dither = checked))),
      checkbox('Outlines', look.outline, (checked) => this.edit(() => (look.outline = checked))),
    ];
  }

  private limits(draft: AppSettings): Node[] {
    const limits = draft.limits;
    return [
      field('BUDGET PER RUN ($)', numberInput(limits.maxRunCostUsd, 0.5, 1_000, 0.5, (value) => this.edit(() => (limits.maxRunCostUsd = value))), 'The run stops when its priced spend passes this.'),
      field('TOKENS PER RUN', numberInput(limits.maxRunTokens, 10_000, 1_000_000_000, 10_000, (value) => this.edit(() => (limits.maxRunTokens = Math.round(value)))), 'Also stops runs on unpriced and local models.'),
      field('TURNS PER TASK', numberInput(limits.maxTurnsPerTask, 1, 200, 1, (value) => this.edit(() => (limits.maxTurnsPerTask = Math.round(value))))),
      field('TASKS PER RUN', numberInput(limits.maxTasks, 1, 100, 1, (value) => this.edit(() => (limits.maxTasks = Math.round(value))))),
      field('PLANNING ROUNDS', numberInput(limits.maxRounds, 1, 10, 1, (value) => this.edit(() => (limits.maxRounds = Math.round(value))))),
      el('h3', 'panel__subtitle', 'WORKSPACE'),
      field('FOLDER', textInput(draft.workspace, 500, (value) => this.edit(() => (draft.workspace = value.trim()))), 'The only folder agents can read and write. Use a dedicated folder, never your home folder.'),
    ];
  }
}
