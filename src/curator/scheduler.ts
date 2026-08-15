/**
 * Curator scheduling: Hermes' inactivity trigger (idle >= 2h AND last run
 * >= 7d, probed on the activity path) approximated for a resident server —
 * an hourly timer probe against an in-memory activity clock.
 *
 * - Activity is WHITELISTED: only real user turns count (`user/message`
 *   with a user source, and `turn/end`). Title rewrites and plugin
 *   maintenance events must not hold the curator off forever.
 * - Boot sets the activity clock to "now": after a restart the server
 *   waits one full idle window before the first probe can fire.
 * - `lastRunAt` lives in the sidecar's global slot; 0 means "never ran",
 *   and the first probe ANCHORS the cycle instead of firing — a fresh
 *   install must age one full interval before its first pass.
 * - One run at a time: a schedule/manual collision returns undefined to
 *   the loser instead of double-spending tokens.
 * - Without the timer service the curator degrades to manual-only.
 *
 * @module dsh-memory-hermes/curator/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { CuratorState } from '../reviewlog.js'
import { curatorOnce } from './curator.js'
import type { CuratorDeps, CuratorOutcome } from './curator.js'

const HOUR_MS = 3_600_000
/** Probe cadence; the gate conditions do the real pacing. */
export const CHECK_EVERY_MS = HOUR_MS

export interface CuratorStatus {
  readonly running: boolean
  /** 0 = never ran (cycle not yet anchored). */
  readonly lastRunAt: number
  readonly lastActivityAt: number
  /** When the interval gate opens next (idle gate still applies); undefined
   * while disabled or unanchored. */
  readonly nextEligibleAt: number | undefined
}

export interface CuratorControl {
  /** Manual trigger; undefined when a run is already in flight. */
  triggerNow(): Promise<CuratorOutcome | undefined>
  status(): CuratorStatus
}

export function installCuratorScheduler(
  ctx: Context,
  deps: CuratorDeps,
  state: CuratorState,
): CuratorControl {
  let lastActivityAt = Date.now()
  let running = false
  const inflight = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('memory-hermes curator disposed'))
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }, 'memory-hermes: drain curator runs')

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') {
      lastActivityAt = Date.now()
      return
    }
    if (event.type === 'user/message') {
      const source = (event.data as { source?: { kind?: unknown } }).source
      if (source?.kind === 'user') lastActivityAt = Date.now()
    }
  })

  const run = (): Promise<CuratorOutcome | undefined> => {
    if (running) return Promise.resolve(undefined)
    running = true
    // curatorOnce never rejects (it settles every path into an outcome).
    const task = (async () => {
      try {
        const outcome = await curatorOnce(ctx, deps, { signal: lifetime.signal })
        // Any pass that did work — even a failed one — restarts the cycle;
        // hourly retries of a broken route would burn tokens for nothing.
        if (outcome.status !== 'disabled') await state.setLastRunAt(Date.now())
        return outcome
      } finally {
        running = false
      }
    })()
    inflight.add(task)
    void task.then(() => inflight.delete(task), () => inflight.delete(task))
    return task
  }

  const check = (): void => {
    const config = deps.configSource.get()
    if (!config.curatorEnabled) return
    const now = Date.now()
    const lastRun = state.lastRunAt()
    if (lastRun === 0) {
      void state.setLastRunAt(now)
      return
    }
    if (now - lastActivityAt < config.curatorMinIdleHours * HOUR_MS) return
    if (now - lastRun < config.curatorIntervalHours * HOUR_MS) return
    void run()
  }

  ctx.inject(['timer'], (scoped) => {
    const withTimer = scoped as Context & { interval?: (callback: () => void, ms: number) => unknown }
    if (typeof withTimer.interval !== 'function') return
    // The timer mixin hangs the disposer on the current fiber itself.
    withTimer.interval(check, CHECK_EVERY_MS)
  })

  return {
    triggerNow: () => run(),
    status: () => {
      const config = deps.configSource.get()
      const lastRun = state.lastRunAt()
      return {
        running,
        lastRunAt: lastRun,
        lastActivityAt,
        nextEligibleAt: !config.curatorEnabled || lastRun === 0
          ? undefined
          : lastRun + config.curatorIntervalHours * HOUR_MS,
      }
    },
  }
}
