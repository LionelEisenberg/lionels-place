import { describe, it, expect } from 'vitest'
import { isTerminal, isActive, splitJobs, type ContextJob } from './job-helpers'

const mk = (id: string, status: ContextJob['status']): ContextJob =>
  ({ job_id: id, context: 'c', task_type: 't', status } as ContextJob)

describe('job-helpers', () => {
  it('classifies terminal/active', () => {
    expect(isTerminal('succeeded')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('queued')).toBe(false)
    expect(isActive('running')).toBe(true)
    expect(isActive('succeeded')).toBe(false)
  })
  it('splits active vs terminal', () => {
    const { active, terminal } = splitJobs([mk('a', 'running'), mk('b', 'succeeded'), mk('c', 'queued')])
    expect(active.map(j => j.job_id)).toEqual(['a', 'c'])
    expect(terminal.map(j => j.job_id)).toEqual(['b'])
  })
})
