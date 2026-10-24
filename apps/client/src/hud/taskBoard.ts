import type { WorldState } from '../state/world';
import { Region, button, el } from './dom';
import { TASK_COLUMNS, tasksByColumn } from './format';

/** The live version of the corkboard: every task by state, and the current plan. */
export class TaskBoard {
  private readonly region = new Region(el('div', 'task-board'));

  constructor(private readonly onSelectAgent: (agentId: string) => void) {}

  get element(): HTMLElement {
    return this.region.element;
  }

  render(state: WorldState): void {
    const nameOf = (id: string) => state.agents.get(id)?.name ?? id.toUpperCase();
    const columns = tasksByColumn(state.tasks);
    const view = {
      plan: state.plan?.markdown ?? null,
      columns: TASK_COLUMNS.map((column) => ({
        column,
        tasks: columns[column].map((task) => ({ title: task.title, agentId: task.agentId, owner: task.agentId ? nameOf(task.agentId) : null })),
      })),
    };
    this.region.render(JSON.stringify(view), () => {
      const nodes: Node[] = [];
      if (view.plan) {
        const plan = el('div', 'task-board__plan');
        plan.append(el('h3', 'panel__subtitle', 'WHITEBOARD PLAN'), el('p', '', view.plan));
        nodes.push(plan);
      }
      if (state.tasks.size === 0) nodes.push(el('p', 'panel__empty', 'No tasks yet. The Boss is still planning.'));
      for (const { column, tasks } of view.columns) {
        if (!tasks.length && (column === 'review' || column === 'failed')) continue;
        const group = el('section', `task-column task-column--${column}`);
        group.append(el('h3', 'panel__subtitle', `${column.toUpperCase()} (${tasks.length})`));
        const list = el('ul', 'task-list');
        for (const task of tasks) {
          const item = el('li', 'task-card');
          item.append(el('span', 'task-card__title', task.title));
          if (task.agentId && task.owner) {
            const agentId = task.agentId;
            item.append(button('link-button', task.owner, () => this.onSelectAgent(agentId)));
          } else {
            item.append(el('span', 'task-card__unassigned', 'UNASSIGNED'));
          }
          list.append(item);
        }
        group.append(list);
        nodes.push(group);
      }
      return nodes;
    });
  }
}
