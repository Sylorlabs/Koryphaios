/**
 * TaskPlanningService
 * Breaks down complex tasks into subtasks and creates execution plans
 */

import { routingLog } from '../../logger';

export interface SubTask {
  id: string;
  description: string;
  dependencies: string[];
  estimatedEffort: number; // in minutes
  requiredCapabilities: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface TaskPlan {
  taskId: string;
  title: string;
  description: string;
  subtasks: SubTask[];
  totalEstimatedEffort: number;
  parallelizable: boolean;
}

export class TaskPlanningService {
  private plans = new Map<string, TaskPlan>();

  /**
   * Create a plan for a complex task
   */
  async createPlan(taskId: string, description: string): Promise<TaskPlan> {
    routingLog.info({ taskId }, 'Creating task plan');

    // Placeholder implementation - actual would use LLM to break down task
    const plan: TaskPlan = {
      taskId,
      title: `Plan for: ${description.slice(0, 50)}...`,
      description,
      subtasks: [
        {
          id: `${taskId}-1`,
          description: 'Analyze requirements',
          dependencies: [],
          estimatedEffort: 5,
          requiredCapabilities: ['analysis'],
          status: 'pending',
        },
        {
          id: `${taskId}-2`,
          description: 'Implement solution',
          dependencies: [`${taskId}-1`],
          estimatedEffort: 30,
          requiredCapabilities: ['coding'],
          status: 'pending',
        },
        {
          id: `${taskId}-3`,
          description: 'Review and test',
          dependencies: [`${taskId}-2`],
          estimatedEffort: 10,
          requiredCapabilities: ['review'],
          status: 'pending',
        },
      ],
      totalEstimatedEffort: 45,
      parallelizable: false,
    };

    this.plans.set(taskId, plan);
    return plan;
  }

  /**
   * Get a task plan
   */
  getPlan(taskId: string): TaskPlan | undefined {
    return this.plans.get(taskId);
  }

  /**
   * Update subtask status
   */
  updateSubtaskStatus(taskId: string, subtaskId: string, status: SubTask['status']): void {
    const plan = this.plans.get(taskId);
    if (plan) {
      const subtask = plan.subtasks.find((st) => st.id === subtaskId);
      if (subtask) {
        subtask.status = status;
        routingLog.debug({ taskId, subtaskId, status }, 'Subtask status updated');
      }
    }
  }

  /**
   * Get next ready subtasks (dependencies completed)
   */
  getReadySubtasks(taskId: string): SubTask[] {
    const plan = this.plans.get(taskId);
    if (!plan) return [];

    return plan.subtasks.filter((st) => {
      if (st.status !== 'pending') return false;
      return st.dependencies.every((depId) => {
        const dep = plan.subtasks.find((s) => s.id === depId);
        return dep?.status === 'completed';
      });
    });
  }

  /**
   * Check if all subtasks are completed
   */
  isPlanComplete(taskId: string): boolean {
    const plan = this.plans.get(taskId);
    if (!plan) return false;
    return plan.subtasks.every((st) => st.status === 'completed');
  }
}

export const taskPlanningService = new TaskPlanningService();
