import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Resolved } from '../src/config.js'
import type { CuratorDeps } from '../src/curator/curator.js'
import { installCuratorScheduler } from '../src/curator/scheduler.js'
import { MemoryCuratorState, MemorySkillTelemetry } from '../src/reviewlog.js'
import { fixedConfigSource } from '../src/settings.js'
import { CuratorSkillStore } from '../src/skills/store.js'

const HOUR = 3_600_000
const T0 = 1_755_000_000_000

const DEFAULTS: Resolved = {
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  securityScan: true,
  approval: false,
  backgroundReview: true,
  reviewMaxTokens: 1000,
  reviewTimeoutMs: 60_000,
  reviewTrigger: 'every-turn',
  reviewTokenDeltaTokens: 4000,
  compactionHarvest: true,
  reviewHistoryLimit: 200,
  consolidateMaxTokens: 2000,
  skillReview: true,
  reviewMaxSteps: 8,
  skillMaxBytes: 65536,
  curatorEnabled: true,
  curatorConsolidate: true,
  curatorIntervalHours: 4,
  curatorMinIdleHours: 2,
  curatorStaleAfterDays: 30,
  curatorMaxSteps: 16,
  curatorMaxTokens: 4000,
  curatorTimeoutMs: 300_000,
  curatorMaxBackups: 5,
}

let dir: string

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  dir = mkdtempSync(join(tmpdir(), 'dsh-curator-sched-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Fake ctx capturing session listeners and the timer probe callback. */
function schedulerCtx() {
  const listeners: ((session: unknown, event: unknown) => void)[] = []
  let tick: (() => void) | undefined
  let intervalMs: number | undefined
  const ctx = {
    on: (name: string, callback: (session: unknown, event: unknown) => void) => {
      if (name === 'session/event') listeners.push(callback)
    },
    effect: () => {},
    inject: (keys: string[], callback: (scoped: unknown) => void) => {
      if (keys[0] === 'timer') {
        callback({ interval: (fn: () => void, ms: number) => { tick = fn; intervalMs = ms } })
      }
    },
    logger: { warn: vi.fn(), info: vi.fn() },
    // curatorOnce only reaches llm on the consolidation path; these tests
    // stay on the sweep path (empty library / consolidation off).
    llm: { stream: vi.fn() },
  } as unknown as Context
  return {
    ctx,
    fire: (event: unknown) => { for (const listener of listeners) listener({}, event) },
    tick: () => tick?.(),
    hasTimer: () => tick !== undefined,
    intervalMs: () => intervalMs,
  }
}

function depsOf(over: Partial<Resolved> = {}): CuratorDeps {
  return {
    configSource: fixedConfigSource({ ...DEFAULTS, ...over }),
    skillStore: new CuratorSkillStore({ root: join(dir, 'skills'), maxFileBytes: 65536 }),
    telemetry: new MemorySkillTelemetry(),
    backupRoot: join(dir, 'backups'),
  }
}

describe('installCuratorScheduler', () => {
  it('registers an hourly probe on the timer service', () => {
    const { ctx, hasTimer, intervalMs } = schedulerCtx()
    installCuratorScheduler(ctx, depsOf(), new MemoryCuratorState())
    expect(hasTimer()).toBe(true)
    expect(intervalMs()).toBe(HOUR)
  })

  it('anchors the cycle on the first probe instead of running', async () => {
    const { ctx, tick } = schedulerCtx()
    const state = new MemoryCuratorState()
    const control = installCuratorScheduler(ctx, depsOf(), state)
    expect(state.lastRunAt()).toBe(0)
    tick()
    await vi.waitFor(() => { expect(state.lastRunAt()).toBe(T0) })
    expect(control.status().running).toBe(false)
  })

  it('fires only when both the idle and the interval gates are open', async () => {
    const { ctx, tick } = schedulerCtx()
    const state = new MemoryCuratorState()
    await state.setLastRunAt(T0 - 5 * HOUR)
    installCuratorScheduler(ctx, depsOf(), state)

    // Idle gate closed: activity was at T0 (boot), only 1h ago.
    vi.setSystemTime(T0 + 1 * HOUR)
    tick()
    await Promise.resolve()
    expect(state.lastRunAt()).toBe(T0 - 5 * HOUR)

    // Both gates open (idle 3h >= 2h, since-run 8h >= 4h): the run fires
    // and restamps the cycle. waitFor advances the fake clock while polling,
    // so the stamp is at-or-after the probe time.
    vi.setSystemTime(T0 + 3 * HOUR)
    tick()
    await vi.waitFor(() => { expect(state.lastRunAt()).toBeGreaterThanOrEqual(T0 + 3 * HOUR) })
  })

  it('holds while the interval gate is closed even when idle', async () => {
    const { ctx, tick } = schedulerCtx()
    const state = new MemoryCuratorState()
    await state.setLastRunAt(T0 - 1 * HOUR)
    installCuratorScheduler(ctx, depsOf(), state)
    vi.setSystemTime(T0 + 3 * HOUR)
    // since-run = 4h... exactly at the boundary opens; use 3h59m to hold.
    vi.setSystemTime(T0 + 2 * HOUR + 59 * 60_000)
    tick()
    await Promise.resolve()
    expect(state.lastRunAt()).toBe(T0 - 1 * HOUR)
  })

  it('whitelists activity: user messages and turn ends count, others do not', async () => {
    const { ctx, tick, fire } = schedulerCtx()
    const state = new MemoryCuratorState()
    await state.setLastRunAt(T0 - 24 * HOUR)
    const control = installCuratorScheduler(ctx, depsOf(), state)

    // A plugin-sourced message (e.g. a title rewrite) must NOT refresh.
    vi.setSystemTime(T0 + 3 * HOUR)
    fire({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'x' } } })
    expect(control.status().lastActivityAt).toBe(T0)

    // A real user message refreshes and closes the idle gate.
    fire({ type: 'user/message', data: { source: { kind: 'user' } } })
    expect(control.status().lastActivityAt).toBe(T0 + 3 * HOUR)
    tick()
    await Promise.resolve()
    expect(state.lastRunAt()).toBe(T0 - 24 * HOUR)

    // turn/end also refreshes.
    vi.setSystemTime(T0 + 4 * HOUR)
    fire({ type: 'turn/end', data: {} })
    expect(control.status().lastActivityAt).toBe(T0 + 4 * HOUR)
  })

  it('does nothing while curatorEnabled is off (fire-time check)', async () => {
    const { ctx, tick } = schedulerCtx()
    const state = new MemoryCuratorState()
    installCuratorScheduler(ctx, depsOf({ curatorEnabled: false }), state)
    vi.setSystemTime(T0 + 100 * HOUR)
    tick()
    await Promise.resolve()
    expect(state.lastRunAt()).toBe(0)
  })

  it('mutual exclusion: the second concurrent trigger returns undefined', async () => {
    const { ctx } = schedulerCtx()
    const control = installCuratorScheduler(ctx, depsOf(), new MemoryCuratorState())
    const [first, second] = await Promise.all([control.triggerNow(), control.triggerNow()])
    expect(first?.status).toBe('swept')
    expect(second).toBeUndefined()
    // After settling, a new trigger is accepted again.
    const third = await control.triggerNow()
    expect(third?.status).toBe('swept')
  })

  it('manual runs restamp the cycle and work without the timer service', async () => {
    const listeners: unknown[] = []
    const ctx = {
      on: (_name: string, callback: unknown) => { listeners.push(callback) },
      effect: () => {},
      inject: () => {},
      logger: { warn: vi.fn(), info: vi.fn() },
      llm: { stream: vi.fn() },
    } as unknown as Context
    const state = new MemoryCuratorState()
    const control = installCuratorScheduler(ctx, depsOf(), state)
    const outcome = await control.triggerNow()
    expect(outcome?.status).toBe('swept')
    expect(state.lastRunAt()).toBe(T0)
    expect(control.status().nextEligibleAt).toBe(T0 + 4 * HOUR)
  })

  it('status reports the unanchored and disabled shapes', () => {
    const { ctx } = schedulerCtx()
    const control = installCuratorScheduler(ctx, depsOf(), new MemoryCuratorState())
    expect(control.status()).toEqual({
      running: false,
      lastRunAt: 0,
      lastActivityAt: T0,
      nextEligibleAt: undefined,
    })
    const disabled = installCuratorScheduler(ctx, depsOf({ curatorEnabled: false }), new MemoryCuratorState())
    expect(disabled.status().nextEligibleAt).toBeUndefined()
  })
})
