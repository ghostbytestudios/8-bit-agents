import { MAX_SKILL_BODY, SkillDraftSchema, type HarnessCommand, type Skill, type SkillDraft, type SkillRole } from '@harness/protocol';
import { button, el, Region } from './dom';
import { Modal } from './modal';

/**
 * The War Room's skill shelf: notes that teach the team how you like things done. Each
 * skill says when to use it (agents see that line in their instructions) and what to do
 * (they read it in full when it fits). Skills apply from the next run.
 */

const ROLES: ReadonlyArray<[SkillRole, string]> = [['boss', 'BOSS'], ['architect', 'ARCHITECT'], ['worker', 'WORKERS']];
const NEW_DRAFT: SkillDraft = { name: '', description: '', roles: ['worker'], enabled: true, body: '' };
const MAX_NAME = 64;
const MAX_DESCRIPTION = 300;

export interface SkillsPanelHandlers {
  send(command: HarnessCommand): boolean;
}

function sameDraft(a: SkillDraft, b: SkillDraft): boolean {
  return a.name === b.name && a.description === b.description && a.enabled === b.enabled && a.body === b.body
    && a.roles.length === b.roles.length && a.roles.every((role) => b.roles.includes(role));
}

/** The first thing wrong with a draft, in words; null when it can be saved. */
export function draftProblem(draft: SkillDraft): string | null {
  if (!draft.name.trim()) return 'Give the skill a name.';
  if (!draft.description.trim()) return 'Say when agents should use it.';
  if (!draft.roles.length) return 'Pick at least one role to give it to.';
  const parsed = SkillDraftSchema.safeParse(draft);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return `${String(issue.path[0] ?? 'skill')}: ${issue.message}`;
}

export class SkillsPanel {
  private readonly modal: Modal;
  private readonly list = new Region(el('div', 'skills__list'));
  private readonly name = el('input', 'pixel-input');
  private readonly description = el('textarea', 'pixel-input skills__description');
  private readonly body = el('textarea', 'pixel-input skills__body');
  private readonly bodyCount = el('span', 'settings-field__hint');
  private readonly enabled = el('input');
  private readonly roleBoxes = new Map<SkillRole, HTMLInputElement>();
  private readonly editorTitle = el('h3', 'welcome__step-title');
  private readonly saveButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private skills: Skill[] = [];
  /** The skill being edited (no id while it's new), and what it looked like when loaded. */
  private draft: SkillDraft = { ...NEW_DRAFT };
  private baseline: SkillDraft = { ...NEW_DRAFT };
  /** After SAVE: select the skill once the shelf comes back with it. */
  private pendingName: string | null = null;
  private isDeleteArmed = false;

  constructor(parent: HTMLElement, private readonly handlers: SkillsPanelHandlers) {
    this.modal = new Modal(parent, {
      id: 'skills',
      title: 'SKILLS',
      className: 'skills',
      canClose: () => this.confirmDiscard(),
    });
    this.saveButton = button('pixel-button', 'SAVE', () => this.save());
    this.deleteButton = button('pixel-button skills__delete', 'DELETE', () => this.remove());
    this.modal.footer.append(this.deleteButton, this.saveButton);

    const side = el('div', 'skills__side');
    side.append(button('pixel-button skills__new', '+ NEW SKILL', () => this.edit(null)), this.list.element);
    const columns = el('div', 'skills__columns');
    columns.append(side, this.buildEditor());
    this.modal.body.append(
      el('p', 'welcome__text', 'Teach the team how you like things done. Agents see each skill\'s name and "when to use it", and read the instructions when they fit the work. Changes apply from the next run.'),
      columns,
    );
    this.load(NEW_DRAFT);
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(): void {
    this.modal.open();
    if (!this.handlers.send({ type: 'skills.list' })) this.showError('Not connected to the server.');
  }

  close(): void {
    this.modal.close();
  }

  setSkills(skills: readonly Skill[]): void {
    this.skills = [...skills];
    const pending = this.pendingName?.toLowerCase();
    const saved = pending ? this.skills.find((skill) => skill.name.toLowerCase() === pending) : undefined;
    if (saved) {
      this.pendingName = null;
      this.load(saved);
      this.modal.showNotice(`Saved "${saved.name}". It applies from the next run.`, 'ok');
    } else if (this.draft.id) {
      const current = this.skills.find((skill) => skill.id === this.draft.id);
      if (!current) {
        this.load(NEW_DRAFT);
        this.modal.showNotice('That skill was deleted.');
      } else if (!this.isDirty) this.load(current);
    }
    this.renderList();
  }

  showError(message: string): void {
    this.pendingName = null;
    this.modal.showNotice(message, 'error');
  }

  private get isDirty(): boolean {
    return !sameDraft(this.draft, this.baseline);
  }

  private buildEditor(): HTMLElement {
    const editor = el('section', 'settings-card skills__editor');
    this.name.maxLength = MAX_NAME;
    this.name.placeholder = 'e.g. Python style';
    this.description.maxLength = MAX_DESCRIPTION;
    this.description.rows = 2;
    this.description.placeholder = 'e.g. When writing or changing Python code';
    this.body.rows = 12;
    this.body.maxLength = MAX_SKILL_BODY;
    this.body.spellcheck = false;
    this.body.placeholder = '# Python style\n\n- Type hints everywhere\n- Tests with pytest';
    this.enabled.type = 'checkbox';

    const roles = el('div', 'settings-row');
    for (const [role, label] of ROLES) {
      const box = el('input');
      box.type = 'checkbox';
      this.roleBoxes.set(role, box);
      const wrapper = el('label', 'settings-check');
      wrapper.append(box, el('span', '', label));
      roles.append(wrapper);
    }
    const enabled = el('label', 'settings-check');
    enabled.append(this.enabled, el('span', '', 'ON (agents get this skill)'));

    const field = (label: string, control: HTMLElement, hint?: HTMLElement) => {
      const wrapper = el('label', 'settings-field');
      wrapper.append(el('span', 'settings-field__label', label), control);
      if (hint) wrapper.append(hint);
      return wrapper;
    };
    const rolesField = el('div', 'settings-field');
    rolesField.append(el('span', 'settings-field__label', 'WHO GETS IT'), roles);
    editor.append(
      this.editorTitle,
      field('NAME', this.name),
      field('WHEN TO USE IT', this.description),
      rolesField,
      enabled,
      field('INSTRUCTIONS (MARKDOWN)', this.body, this.bodyCount),
    );
    editor.addEventListener('input', () => this.readForm());
    return editor;
  }

  /** Puts a skill (or a blank new one) into the form. */
  private load(skill: SkillDraft): void {
    this.draft = { ...skill, roles: [...skill.roles] };
    this.baseline = { ...this.draft, roles: [...this.draft.roles] };
    this.isDeleteArmed = false;
    this.name.value = skill.name;
    this.description.value = skill.description;
    this.body.value = skill.body;
    this.enabled.checked = skill.enabled;
    for (const [role, box] of this.roleBoxes) box.checked = skill.roles.includes(role);
    this.editorTitle.textContent = skill.id ? `EDIT: ${skill.name}` : 'NEW SKILL';
    this.updateControls();
    this.renderList();
  }

  private readForm(): void {
    this.draft = {
      ...this.draft,
      name: this.name.value,
      description: this.description.value,
      body: this.body.value,
      enabled: this.enabled.checked,
      roles: ROLES.map(([role]) => role).filter((role) => this.roleBoxes.get(role)?.checked),
    };
    this.isDeleteArmed = false;
    this.updateControls();
  }

  private updateControls(): void {
    this.saveButton.disabled = !this.isDirty;
    this.deleteButton.hidden = !this.draft.id;
    this.deleteButton.textContent = this.isDeleteArmed ? 'SURE? DELETE' : 'DELETE';
    this.bodyCount.textContent = `${this.body.value.length.toLocaleString('en-US')} / ${MAX_SKILL_BODY.toLocaleString('en-US')} characters`;
  }

  private confirmDiscard(): boolean {
    return !this.isDirty || window.confirm('Discard your unsaved changes to this skill?');
  }

  private edit(skill: Skill | null): void {
    if (skill && skill.id === this.draft.id) return;
    if (!this.confirmDiscard()) return;
    this.load(skill ?? NEW_DRAFT);
    this.modal.showNotice('');
    (skill ? this.body : this.name).focus();
  }

  private save(): void {
    const problem = draftProblem(this.draft);
    if (problem) {
      this.modal.showNotice(problem, 'error');
      return;
    }
    const draft = { ...this.draft, name: this.draft.name.trim(), description: this.draft.description.trim() };
    if (!this.handlers.send({ type: 'skill.save', skill: draft })) {
      this.showError('Not connected to the server.');
      return;
    }
    this.pendingName = draft.name;
    this.modal.showNotice('Saving…');
  }

  private remove(): void {
    const { id } = this.draft;
    if (!id) return;
    if (!this.isDeleteArmed) {
      this.isDeleteArmed = true;
      this.updateControls();
      return;
    }
    if (!this.handlers.send({ type: 'skill.delete', id })) {
      this.showError('Not connected to the server.');
      return;
    }
    this.load(NEW_DRAFT);
    this.modal.showNotice('Deleted.');
  }

  private renderList(): void {
    const signature = JSON.stringify([this.skills.map((skill) => [skill.id, skill.name, skill.roles, skill.enabled]), this.draft.id]);
    this.list.render(signature, () => {
      if (!this.skills.length) return [el('p', 'settings-field__hint', 'No skills yet. Add one, or copy SKILL.md folders into the app\'s skills folder.')];
      return this.skills.map((skill) => {
        const item = button('skills__item', '', () => this.edit(skill));
        if (skill.id === this.draft.id) item.setAttribute('aria-current', 'true');
        const roles = skill.roles.length === ROLES.length
          ? 'EVERYONE'
          : ROLES.filter(([role]) => skill.roles.includes(role)).map(([, label]) => label).join(' · ');
        item.append(el('span', 'skills__item-name', skill.name), el('span', 'skills__item-roles', skill.enabled ? roles : `OFF · ${roles}`));
        if (!skill.enabled) item.classList.add('is-off');
        return item;
      });
    });
  }
}
