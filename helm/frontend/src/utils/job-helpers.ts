export interface ContextJob {
  job_id: string
  context: string
  task_type: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  response_text?: string | null
  response_payload?: Record<string, unknown> | null
  error?: string | null
}

export const isTerminal = (s: ContextJob['status']) => s === 'succeeded' || s === 'failed'
export const isActive = (s: ContextJob['status']) => s === 'queued' || s === 'running'

export function splitJobs(jobs: ContextJob[]): { active: ContextJob[]; terminal: ContextJob[] } {
  return {
    active: jobs.filter(j => isActive(j.status)),
    terminal: jobs.filter(j => isTerminal(j.status)),
  }
}
