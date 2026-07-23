/**
 * useContextJobs — server-authoritative reconnect for a view's LLM jobs.
 * On mount and while any job is active, polls /api/llm-jobs?context=; delivers each
 * terminal (succeeded/failed) unacked result exactly once. By default it then acks the
 * job so it won't be redelivered. For results the user must resolve (e.g. a parse card
 * awaiting confirm/discard), pass ackOnDeliver:false and call the returned ack(jobId)
 * on resolution — the job stays unacked, so the result survives page refreshes and
 * shows on other devices until then. submit() kicks off the async endpoint + polls.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { listContextJobs, ackLlmJob } from './api'
import type { LLMJobResponse } from './api'
import { isActive } from './utils/job-helpers'

const POLL_MS = 2500

interface Opts<T> {
  transform: (raw: Record<string, unknown>) => T
  onResult: (result: T, jobId: string) => void   // jobId === the LLM job id (a.k.a request_log_id)
  onError: (error: string) => void
  ackOnDeliver?: boolean   // default true; false = defer ack, caller acks on user resolution
}

interface TickDeps<T> {
  transform: (raw: Record<string, unknown>) => T
  onResult: (result: T, jobId: string) => void
  onError: (error: string) => void
  ack: (jobId: string) => void
  ackOnDeliver?: boolean   // default true
}

function parseResult(job: LLMJobResponse): Record<string, unknown> {
  if (job.response_payload) return job.response_payload
  if (job.response_text) {
    try { return JSON.parse(job.response_text) } catch { return { response: job.response_text } }
  }
  return {}
}

/**
 * Pure delivery logic for a single poll tick: for each job, deliver terminal
 * (succeeded/failed) results exactly once (tracked via `delivered`), then ack them
 * unless deps.ackOnDeliver === false (in which case the caller acks on resolution).
 * Returns whether any job in the batch is still active (queued/running).
 */
export function processContextJobsTick<T>(
  jobs: LLMJobResponse[],
  delivered: Set<string>,
  deps: TickDeps<T>,
): boolean {
  let anyActive = false
  for (const job of jobs) {
    if (isActive(job.status)) { anyActive = true; continue }
    if (delivered.has(job.job_id)) continue
    delivered.add(job.job_id)
    if (job.status === 'succeeded') deps.onResult(deps.transform(parseResult(job)), job.job_id)
    else deps.onError(job.error || 'Job failed')
    if (deps.ackOnDeliver !== false) deps.ack(job.job_id)
  }
  return anyActive
}

export function useContextJobs<T>(context: string, opts: Opts<T>) {
  const [active, setActive] = useState(false)
  const optsRef = useRef(opts); optsRef.current = opts
  const deliveredRef = useRef<Set<string>>(new Set())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tick = useCallback(async () => {
    let anyActive = false
    try {
      const { jobs } = await listContextJobs(context)
      anyActive = processContextJobsTick(jobs, deliveredRef.current, {
        transform: (raw) => optsRef.current.transform(raw),
        onResult: (result, jobId) => optsRef.current.onResult(result, jobId),
        onError: (error) => optsRef.current.onError(error),
        ack: (jobId) => { ackLlmJob(jobId).catch(() => {}) },
        ackOnDeliver: optsRef.current.ackOnDeliver,
      })
    } catch {
      anyActive = true // network hiccup — keep polling
    }
    setActive(anyActive)
    // Clear any pending timer before scheduling so concurrent tick() entry points
    // (mount, visibilitychange, submit) collapse to a single loop — no orphaned/
    // uncancellable timers, no multiplied poll rate.
    if (timer.current) clearTimeout(timer.current)
    timer.current = anyActive ? setTimeout(tick, POLL_MS) : null
  }, [context])

  // Reconnect on mount + resume on tab focus
  useEffect(() => {
    tick()
    const onVis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); if (timer.current) clearTimeout(timer.current) }
  }, [tick])

  const submit = useCallback(async (submitFn: () => Promise<{ job_id: string }>) => {
    try {
      await submitFn()
      setActive(true)
      tick()
    } catch (e) {
      optsRef.current.onError(e instanceof Error ? e.message : 'Failed to submit')
    }
  }, [tick])

  // Manual ack for ackOnDeliver:false consumers — call when the user resolves the
  // result (e.g. confirms/discards a parse card). Marks delivered so a racing poll
  // won't re-emit it, and clears it server-side so it won't reconnect on refresh.
  const ack = useCallback((jobId: string) => {
    deliveredRef.current.add(jobId)
    ackLlmJob(jobId).catch(() => {})
  }, [])

  return { submit, isActive: active, ack }
}
