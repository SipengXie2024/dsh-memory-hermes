import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Resolved } from '../src/config.js'
import { createConfigSource, fixedConfigSource } from '../src/settings.js'

const RESOLVED: Resolved = {
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  securityScan: true,
  approval: false,
  backgroundReview: true,
  reviewMaxTokens: 1000,
  reviewTimeoutMs: 60_000,
  reviewTrigger: 'token-delta',
  reviewTokenDeltaTokens: 4000,
  compactionHarvest: true,
  reviewHistoryLimit: 200,
  consolidateMaxTokens: 2000,
  skillReview: true,
  reviewMaxSteps: 8,
  skillMaxBytes: 65536,
  curatorEnabled: true,
  curatorConsolidate: true,
  curatorIntervalHours: 168,
  curatorMinIdleHours: 2,
  curatorStaleAfterDays: 30,
  curatorMaxSteps: 16,
  curatorMaxTokens: 4000,
  curatorTimeoutMs: 300_000,
  curatorMaxBackups: 5,
}

describe('createConfigSource', () => {
  it('serves the loader config while the settings service is absent', () => {
    const ctx = { inject: vi.fn() } as unknown as Context
    const source = createConfigSource(ctx, RESOLVED, {}, () => {})
    expect(source.get().memoryCharLimit).toBe(2200)
    expect(ctx.inject).toHaveBeenCalledWith(['settings'], expect.any(Function))
  })

  it('swaps in the settings scope when it arrives and notifies facade watchers once', () => {
    const scopeWatchers: ((next: Resolved, prev: Resolved) => void)[] = []
    let current: Resolved = { ...RESOLVED, memoryCharLimit: 3000 }
    const scope = {
      get: () => current,
      watch: (cb: (next: Resolved, prev: Resolved) => void) => { scopeWatchers.push(cb); return () => {} },
    }
    const register = vi.fn(() => scope)
    // Capture the inject callback so the watcher can register BEFORE the
    // scope arrives — the production sequence (service ready after apply).
    let scopedCallback: ((scoped: unknown) => void) | undefined
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => { scopedCallback = callback },
    } as unknown as Context
    const source = createConfigSource(ctx, RESOLVED, { fake: 'schema' }, () => {})
    const seen: [number, number][] = []
    source.watch((next, prev) => { seen.push([next.memoryCharLimit, prev.memoryCharLimit]) })
    scopedCallback!({ get: () => ({ register }) })
    expect(register).toHaveBeenCalledWith('memory-hermes', { fake: 'schema' }, { base: RESOLVED, applies: 'live' })
    // Watchers registered before the swap are notified once with the scope value.
    expect(seen).toEqual([[3000, 2200]])
    // And they ride later scope commits.
    const committed = { ...RESOLVED, memoryCharLimit: 4000 }
    current = committed
    scopeWatchers[0]!(committed, { ...RESOLVED, memoryCharLimit: 3000 })
    expect(seen[1]).toEqual([4000, 3000])
    expect(source.get().memoryCharLimit).toBe(4000)
  })

  it('a throwing registration falls back with a warning', () => {
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => {
        callback({
          get: () => ({
            register: () => { throw new Error('stored section invalid') },
          }),
        })
      },
    } as unknown as Context
    const warn = vi.fn()
    const source = createConfigSource(ctx, RESOLVED, {}, warn)
    expect(source.get().memoryCharLimit).toBe(2200)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('stored section invalid')
  })
})

describe('fixedConfigSource', () => {
  it('never fires its watcher', () => {
    const source = fixedConfigSource(RESOLVED)
    const callback = vi.fn()
    source.watch(callback)
    expect(callback).not.toHaveBeenCalled()
  })
})
