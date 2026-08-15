import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DomainCuratorState,
  DomainReviewLog,
  DomainSkillTelemetry,
  MemoryCuratorState,
  MemoryReviewLog,
  MemorySkillTelemetry,
  createSidecar,
  curatorGlobalSchema,
  memoryHermesDomainSpec,
  reviewRunSchema,
  skillUsageSchema,
} from '../src/reviewlog.js'
import type { ReviewRun, SkillUsage } from '../src/reviewlog.js'

const run = (id: string, startedAt: number, over: Partial<ReviewRun> = {}): ReviewRun => ({
  id,
  sessionId: 'sess-1',
  turn: 1,
  kind: 'turn',
  startedAt,
  settledAt: startedAt + 10,
  applied: 1,
  rejected: 0,
  malformed: 0,
  foreign: 0,
  ...over,
})

const usage = (over: Partial<SkillUsage> = {}): SkillUsage => ({
  useCount: 1,
  firstSeenAt: 1000,
  state: 'active',
  pinned: false,
  ...over,
})

describe('reviewRunSchema', () => {
  it('round-trips a full run and accepts the minimal shape', () => {
    expect(reviewRunSchema.parse(run('a', 1, { entries: ['x'], error: 'boom' }))).toMatchObject({ id: 'a' })
    expect(reviewRunSchema.parse(run('b', 2))).toMatchObject({ id: 'b' })
  })

  it('accepts the curator kind and rejects an unknown one', () => {
    expect(reviewRunSchema.parse(run('c', 3, { kind: 'curator' }))).toMatchObject({ kind: 'curator' })
    expect(() => reviewRunSchema.parse(run('d', 4, { kind: 'hourly' as never }))).toThrow()
  })
})

describe('skillUsageSchema', () => {
  it('round-trips full and minimal rows', () => {
    expect(skillUsageSchema.parse(usage({ lastUsedAt: 2000, createdAt: 1500, pinned: true }))).toMatchObject({ pinned: true })
    expect(skillUsageSchema.parse(usage())).toMatchObject({ state: 'active' })
    expect(() => skillUsageSchema.parse(usage({ state: 'archived' as never }))).toThrow()
  })
})

describe('memoryHermesDomainSpec', () => {
  it('declares the sidecar identity, both tables, and the curator global', () => {
    expect(memoryHermesDomainSpec.name).toBe('memory_hermes')
    expect(memoryHermesDomainSpec.version).toBe(1)
    expect(Object.keys(memoryHermesDomainSpec.tables)).toEqual(['runs', 'skill_usage'])
    expect(memoryHermesDomainSpec.global.initial).toEqual({ curatorLastRunAt: 0 })
    expect(curatorGlobalSchema.parse({ curatorLastRunAt: 42 })).toEqual({ curatorLastRunAt: 42 })
  })
})

describe('MemoryReviewLog', () => {
  it('lists newest first and enforces the ring cap', async () => {
    const log = new MemoryReviewLog(() => 3)
    for (let i = 1; i <= 5; i += 1) await log.record(run(`r${i}`, i))
    expect(log.list().map(entry => entry.id)).toEqual(['r5', 'r4', 'r3'])
  })

  it('reads the limit live', async () => {
    let limit = 10
    const log = new MemoryReviewLog(() => limit)
    for (let i = 1; i <= 5; i += 1) await log.record(run(`r${i}`, i))
    limit = 2
    await log.record(run('r6', 6))
    expect(log.list().map(entry => entry.id)).toEqual(['r6', 'r5'])
  })
})

/** Fake durable table over a Map, recording every mutation. */
const fakeTable = <V,>(seed: [string, V][] = []) => {
  const map = new Map<string, unknown>(seed)
  const puts: string[] = []
  const deletes: string[] = []
  return {
    map,
    puts,
    deletes,
    table: {
      entries: () => map.entries(),
      put: async (key: string, value: unknown) => { puts.push(key); map.set(key, value) },
      delete: async (key: string) => { deletes.push(key); return map.delete(key) },
    },
  }
}

/** Fake open domain: two tables plus the resolved global handle. The real
 * facility resolves the medium's `null` sentinel to the spec initial before
 * the domain is handed out, so the fake starts at the initial value. */
const fakeDomain = (seedRuns: [string, ReviewRun][] = [], seedUsage: [string, SkillUsage][] = []) => {
  const runs = fakeTable<ReviewRun>(seedRuns)
  const skillUsage = fakeTable<SkillUsage>(seedUsage)
  let globalValue: unknown = memoryHermesDomainSpec.global.initial
  const globalSets: unknown[] = []
  const close = vi.fn(async () => {})
  return {
    runs,
    skillUsage,
    globalSets,
    close,
    setGlobal: (value: unknown) => { globalValue = value },
    domain: {
      table: (name: string) => (name === 'runs' ? runs.table : skillUsage.table),
      global: {
        get: () => globalValue,
        set: async (value: unknown) => { globalSets.push(value); globalValue = value },
      },
      close,
    },
  }
}

describe('DomainReviewLog', () => {
  it('seeds the mirror from the medium, newest first', () => {
    const { table } = fakeTable<ReviewRun>([['a', run('a', 1)], ['b', run('b', 2)]])
    const log = new DomainReviewLog(table, () => 200, () => {})
    expect(log.list().map(entry => entry.id)).toEqual(['b', 'a'])
  })

  it('persists records and trims the medium with the ring cap', async () => {
    const { table, map, puts, deletes } = fakeTable<ReviewRun>()
    const log = new DomainReviewLog(table, () => 2, () => {})
    await log.record(run('r1', 1))
    await log.record(run('r2', 2))
    await log.record(run('r3', 3))
    expect(puts).toEqual(['r1', 'r2', 'r3'])
    expect(deletes).toEqual(['r1'])
    expect([...map.keys()]).toEqual(['r2', 'r3'])
    expect(log.list().map(entry => entry.id)).toEqual(['r3', 'r2'])
  })

  it('a persist failure keeps the mirror and only warns', async () => {
    const { table } = fakeTable<ReviewRun>()
    const warn = vi.fn()
    const failing = { ...table, put: async () => { throw new Error('disk on fire') } }
    const log = new DomainReviewLog(failing, () => 10, warn)
    await log.record(run('r1', 1))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(log.list().map(entry => entry.id)).toEqual(['r1'])
  })
})

describe('SkillTelemetry', () => {
  it('memory variant upserts through the mutator and deletes', async () => {
    const telemetry = new MemorySkillTelemetry()
    await telemetry.update('a-skill', current => ({ ...current ?? usage({ useCount: 0 }), useCount: (current?.useCount ?? 0) + 1 }))
    await telemetry.update('a-skill', current => ({ ...current!, useCount: current!.useCount + 1 }))
    expect(telemetry.get('a-skill')?.useCount).toBe(2)
    expect([...telemetry.list().keys()]).toEqual(['a-skill'])
    await telemetry.delete('a-skill')
    expect(telemetry.get('a-skill')).toBeUndefined()
  })

  it('domain variant seeds from the medium and writes through', async () => {
    const { table, map, puts, deletes } = fakeTable<SkillUsage>([['seeded', usage({ useCount: 7 })]])
    const telemetry = new DomainSkillTelemetry(table, () => {})
    expect(telemetry.get('seeded')?.useCount).toBe(7)
    await telemetry.update('fresh', () => usage())
    expect(puts).toEqual(['fresh'])
    expect(map.has('fresh')).toBe(true)
    await telemetry.delete('seeded')
    expect(deletes).toEqual(['seeded'])
    expect(map.has('seeded')).toBe(false)
  })

  it('a telemetry persist failure keeps the mirror and only warns', async () => {
    const { table } = fakeTable<SkillUsage>()
    const warn = vi.fn()
    const failing = { ...table, put: async () => { throw new Error('disk full') } }
    const telemetry = new DomainSkillTelemetry(failing, warn)
    await telemetry.update('a-skill', () => usage())
    expect(warn).toHaveBeenCalledTimes(1)
    expect(telemetry.get('a-skill')).toBeDefined()
  })
})

describe('CuratorState', () => {
  it('memory variant starts at 0 (never ran) and stores the set value', async () => {
    const state = new MemoryCuratorState()
    expect(state.lastRunAt()).toBe(0)
    await state.setLastRunAt(1234)
    expect(state.lastRunAt()).toBe(1234)
  })

  it('domain variant reads the resolved global and writes through', async () => {
    const { domain, globalSets, setGlobal } = fakeDomain()
    setGlobal({ curatorLastRunAt: 500 })
    const state = new DomainCuratorState(domain.global, () => {})
    expect(state.lastRunAt()).toBe(500)
    await state.setLastRunAt(900)
    expect(globalSets).toEqual([{ curatorLastRunAt: 900 }])
  })

  it('a global persist failure keeps the value and only warns', async () => {
    const warn = vi.fn()
    const handle = { get: () => ({ curatorLastRunAt: 0 }), set: async () => { throw new Error('no disk') } }
    const state = new DomainCuratorState(handle, warn)
    await state.setLastRunAt(777)
    expect(state.lastRunAt()).toBe(777)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('createSidecar', () => {
  it('stays memory-only when storageDomain is absent and serves all faces', async () => {
    const ctx = { inject: vi.fn() } as unknown as Context
    const sidecar = createSidecar(ctx, () => 10, () => {})
    await sidecar.log.record(run('r1', 1))
    expect(await sidecar.listRuns()).toHaveLength(1)
    await sidecar.telemetry.update('a-skill', () => usage())
    expect(sidecar.telemetry.get('a-skill')).toBeDefined()
    await sidecar.curatorState.setLastRunAt(5)
    expect(sidecar.curatorState.lastRunAt()).toBe(5)
    expect(ctx.inject).toHaveBeenCalledWith(['storageDomain'], expect.any(Function))
  })

  it('migrates buffered state into the domain once it opens', async () => {
    const fake = fakeDomain()
    const facility = { open: async () => fake.domain }
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => {
        callback({ get: () => facility, effect: vi.fn() })
      },
    } as unknown as Context
    const sidecar = createSidecar(ctx, () => 10, () => {})
    await sidecar.log.record(run('early', 1))
    await sidecar.telemetry.update('early-skill', () => usage())
    await sidecar.curatorState.setLastRunAt(111)
    await vi.waitFor(() => expect([...fake.runs.map.keys()]).toContain('early'))
    await vi.waitFor(() => expect([...fake.skillUsage.map.keys()]).toContain('early-skill'))
    await vi.waitFor(() => expect(fake.globalSets).toContainEqual({ curatorLastRunAt: 111 }))
    expect((await sidecar.listRuns()).map(entry => entry.id)).toEqual(['early'])
  })

  it('opens a v0.3.x-shaped medium: runs only, empty usage, initial global', async () => {
    // An old sidecar file has runs rows, no skill_usage unit, and a null
    // global; the facility serves the added table as empty and resolves the
    // sentinel to `initial` (verified dsh contract) — this pins our side:
    // every face works over that resolved shape.
    const fake = fakeDomain([['old-run', run('old-run', 10)]])
    const facility = { open: async () => fake.domain }
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => {
        callback({ get: () => facility, effect: vi.fn() })
      },
    } as unknown as Context
    const sidecar = createSidecar(ctx, () => 10, () => {})
    await vi.waitFor(async () => expect((await sidecar.listRuns()).map(entry => entry.id)).toEqual(['old-run']))
    expect(sidecar.telemetry.list().size).toBe(0)
    expect(sidecar.curatorState.lastRunAt()).toBe(0)
  })

  it('the dispose effect closes the shared domain', async () => {
    const fake = fakeDomain()
    const facility = { open: async () => fake.domain }
    let disposer: (() => Promise<void>) | undefined
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => {
        callback({
          get: () => facility,
          effect: (factory: () => () => Promise<void>) => { disposer = factory() },
        })
      },
    } as unknown as Context
    createSidecar(ctx, () => 10, () => {})
    await vi.waitFor(() => expect(disposer).toBeDefined())
    await disposer!()
    expect(fake.close).toHaveBeenCalledTimes(1)
  })
})
