import { describe, it, expect, vi } from 'vitest'

vi.mock('./api', () => ({
  listContextJobs: vi.fn(),
  ackLlmJob: vi.fn(),
}))

import { processContextJobsTick } from './useContextJobs'
import type { LLMJobResponse } from './api'

const mk = (over: Partial<LLMJobResponse>): LLMJobResponse => ({
  job_id: 'j1',
  context: 'workout_log',
  task_type: 'plan_workout',
  status: 'succeeded',
  ...over,
})

describe('processContextJobsTick', () => {
  it('delivers a succeeded job result once and acks it', () => {
    const delivered = new Set<string>()
    const onResult = vi.fn()
    const onError = vi.fn()
    const ack = vi.fn()
    const job = mk({ response_text: '{"workout_type":"Push"}' })

    const anyActive = processContextJobsTick([job], delivered, {
      transform: (r) => r as unknown as { workout_type: string },
      onResult,
      onError,
      ack,
    })

    expect(onResult).toHaveBeenCalledWith({ workout_type: 'Push' }, 'j1')
    expect(ack).toHaveBeenCalledWith('j1')
    expect(anyActive).toBe(false)
    expect(delivered.has('j1')).toBe(true)
  })

  it('delivers but does NOT ack when ackOnDeliver is false (caller acks on resolution)', () => {
    const delivered = new Set<string>()
    const onResult = vi.fn()
    const ack = vi.fn()
    const job = mk({ response_text: '{"workout_type":"Push"}' })

    processContextJobsTick([job], delivered, {
      transform: (r) => r as unknown as { workout_type: string },
      onResult,
      onError: vi.fn(),
      ack,
      ackOnDeliver: false,
    })

    expect(onResult).toHaveBeenCalledWith({ workout_type: 'Push' }, 'j1')
    expect(ack).not.toHaveBeenCalled()      // stays unacked -> survives refresh until resolved
    expect(delivered.has('j1')).toBe(true)  // still delivered-once within the session
  })

  it('does not redeliver an already-delivered job', () => {
    const delivered = new Set<string>(['j1'])
    const onResult = vi.fn()
    const ack = vi.fn()
    const job = mk({ response_text: '{"workout_type":"Push"}' })

    processContextJobsTick([job], delivered, {
      transform: (r) => r,
      onResult,
      onError: vi.fn(),
      ack,
    })

    expect(onResult).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
  })

  it('reports active jobs and does not deliver or ack them', () => {
    const delivered = new Set<string>()
    const onResult = vi.fn()
    const ack = vi.fn()
    const job = mk({ status: 'running', response_text: null })

    const anyActive = processContextJobsTick([job], delivered, {
      transform: (r) => r,
      onResult,
      onError: vi.fn(),
      ack,
    })

    expect(anyActive).toBe(true)
    expect(onResult).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
  })

  it('delivers a failed job via onError', () => {
    const delivered = new Set<string>()
    const onError = vi.fn()
    const ack = vi.fn()
    const job = mk({ status: 'failed', error: 'boom', response_text: null })

    processContextJobsTick([job], delivered, {
      transform: (r) => r,
      onResult: vi.fn(),
      onError,
      ack,
    })

    expect(onError).toHaveBeenCalledWith('boom')
    expect(ack).toHaveBeenCalledWith('j1')
  })

  it('falls back to response_payload over response_text', () => {
    const delivered = new Set<string>()
    const onResult = vi.fn()
    const job = mk({ response_payload: { workout_type: 'Pull' }, response_text: '{"workout_type":"Push"}' })

    processContextJobsTick([job], delivered, {
      transform: (r) => r,
      onResult,
      onError: vi.fn(),
      ack: vi.fn(),
    })

    expect(onResult).toHaveBeenCalledWith({ workout_type: 'Pull' }, 'j1')
  })
})
