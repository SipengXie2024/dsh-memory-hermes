import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DomainReviewLog,
  MemoryReviewLog,
  createReviewLog,
  memoryHermesDomainSpec,
  reviewRunSchema,
} from '../src/reviewlog.js'
import type { ReviewRun } from '../src/reviewlog.js'

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

describe('reviewRunSchema', () => {
  it('round-trips a full run and accepts the minimal shape', () => {
    expect(reviewRunSchema.parse(run('a', 1, { entries: ['x'], error: 'boom' }))).toMatchObject({ id: 'a' })
    expect(reviewRunSchema.parse(run('b', 2))).toMatchObject({ id: 'b' })
  })

  it('rejects an unknown kind', () => {
    expect(() => reviewRunSchema.parse(run('c', 3, { kind: 'hourly' as never }))).toThrow()
  })
})

describe('memoryHermesDomainSpec', () => {
  it('declares the sidecar identity and one runs table', () => {
    expect(memoryHermesDomainSpec.name).toBe('memory_hermes')
    expect(memoryHermesDomainSpec.version).toBe(1)
    expect(Object.keys(memoryHermesDomainSpec.tables)).toEqual(['runs'])
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
const fakeTable = (seed: [string, ReviewRun][] = []) => {
  const map = new Map(seed)
  const puts: string[] = []
  const deletes: string[] = []
  return {
    map,
    puts,
    deletes,
    table: {
      entries: () => map.entries(),
      put: async (key: string, value: ReviewRun) => { puts.push(key); map.set(key, value) },
      delete: async (key: string) => { deletes.push(key); return map.delete(key) },
    },
  }
}

describe('DomainReviewLog', () => {
  const openWith = async (seed: [string, ReviewRun][] = [], limit = 200) => {
    const { table, map, puts, deletes } = fakeTable(seed)
    const close = vi.fn(async () => {})
    const facility = { open: async () => ({ table: () => table, close }) }
    const log = await DomainReviewLog.open(facility, () => limit, () => {})
    return { log, map, puts, deletes, close }
  }

  it('seeds the mirror from the medium, newest first', async () => {
    const { log } = await openWith([['a', run('a', 1)], ['b', run('b', 2)]])
    expect(log.list().map(entry => entry.id)).toEqual(['b', 'a'])
  })

  it('persists records and trims the medium with the ring cap', async () => {
    const { log, map, puts, deletes } = await openWith([], 2)
    await log.record(run('r1', 1))
    await log.record(run('r2', 2))
    await log.record(run('r3', 3))
    expect(puts).toEqual(['r1', 'r2', 'r3'])
    expect(deletes).toEqual(['r1'])
    expect([...map.keys()]).toEqual(['r2', 'r3'])
    expect(log.list().map(entry => entry.id)).toEqual(['r3', 'r2'])
  })

  it('a persist failure keeps the mirror and only warns', async () => {
    const { table } = fakeTable()
    const warn = vi.fn()
    const failing = { ...table, put: async () => { throw new Error('disk on fire') } }
    const facility = { open: async () => ({ table: () => failing, close: async () => {} }) }
    const log = await DomainReviewLog.open(facility, () => 10, warn)
    await log.record(run('r1', 1))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(log.list().map(entry => entry.id)).toEqual(['r1'])
  })

  it('close delegates to the domain', async () => {
    const { log, close } = await openWith()
    await log.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('createReviewLog', () => {
  it('stays memory-only when storageDomain is absent and serves listRuns', async () => {
    const ctx = { inject: vi.fn() } as unknown as Context
    const handle = createReviewLog(ctx, () => 10, () => {})
    await handle.log.record(run('r1', 1))
    expect(await handle.listRuns()).toHaveLength(1)
    expect(ctx.inject).toHaveBeenCalledWith(['storageDomain'], expect.any(Function))
  })

  it('migrates buffered runs into the domain log once it opens', async () => {
    const { table, map } = fakeTable()
    const facility = { open: async () => ({ table: () => table, close: async () => {} }) }
    const ctx = {
      inject: (_deps: string[], callback: (scoped: unknown) => void) => {
        callback({ get: () => facility, effect: vi.fn() })
      },
    } as unknown as Context
    const handle = createReviewLog(ctx, () => 10, () => {})
    await handle.log.record(run('early', 1))
    await vi.waitFor(() => expect([...map.keys()]).toContain('early'))
    expect((await handle.listRuns()).map(entry => entry.id)).toEqual(['early'])
  })
})
