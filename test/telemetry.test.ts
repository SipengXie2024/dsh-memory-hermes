import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.js'
import type { Resolved } from '../src/config.js'
import { bumpUsage, createSkillTelemetryHooks, installUsageTelemetry, seedUsage } from '../src/curator/telemetry.js'
import { MemorySkillTelemetry } from '../src/reviewlog.js'
import type { SkillUsage } from '../src/reviewlog.js'

const configSource = (over: Partial<Resolved> = {}) => {
  const resolved = { ...new Config({}) as Resolved, ...over }
  return { get: () => resolved, watch: () => () => {} }
}

const usage = (over: Partial<SkillUsage> = {}): SkillUsage => ({
  useCount: 3,
  firstSeenAt: 1000,
  state: 'active',
  pinned: false,
  ...over,
})

describe('seedUsage / bumpUsage', () => {
  it('seeds a fresh unpinned active row anchored at now', () => {
    expect(seedUsage(500)).toEqual({ useCount: 0, firstSeenAt: 500, state: 'active', pinned: false })
  })

  it('bump counts, stamps, and reactivates; absent rows are seeded first', () => {
    const bumped = bumpUsage(usage({ state: 'stale', useCount: 2 }), 9000)
    expect(bumped).toMatchObject({ useCount: 3, lastUsedAt: 9000, state: 'active' })
    expect(bumpUsage(undefined, 42)).toEqual({ useCount: 1, firstSeenAt: 42, lastUsedAt: 42, state: 'active', pinned: false })
  })

  it('bump preserves pins and provenance timestamps', () => {
    const bumped = bumpUsage(usage({ pinned: true, createdAt: 800 }), 9000)
    expect(bumped.pinned).toBe(true)
    expect(bumped.createdAt).toBe(800)
    expect(bumped.firstSeenAt).toBe(1000)
  })
})

describe('createSkillTelemetryHooks', () => {
  it('onCreate resets any leftover row to a fresh created one', async () => {
    const telemetry = new MemorySkillTelemetry()
    await telemetry.update('reborn', () => usage({ useCount: 9, state: 'stale', pinned: true }))
    const hooks = createSkillTelemetryHooks({ telemetry, configSource: configSource() })
    hooks.onCreate!('reborn')
    await Promise.resolve()
    const row = telemetry.get('reborn')
    expect(row).toMatchObject({ useCount: 0, state: 'active', pinned: false })
    expect(row?.createdAt).toBeTypeOf('number')
  })

  it('onDelete drops the row; a leftover would poison a future same-named skill', async () => {
    const telemetry = new MemorySkillTelemetry()
    await telemetry.update('goner', () => usage())
    const hooks = createSkillTelemetryHooks({ telemetry, configSource: configSource() })
    hooks.onDelete!('goner')
    await Promise.resolve()
    expect(telemetry.get('goner')).toBeUndefined()
  })

  it('curatorEnabled: false makes both hooks inert', async () => {
    const telemetry = new MemorySkillTelemetry()
    await telemetry.update('kept', () => usage())
    const hooks = createSkillTelemetryHooks({ telemetry, configSource: configSource({ curatorEnabled: false }) })
    hooks.onCreate!('fresh')
    hooks.onDelete!('kept')
    await Promise.resolve()
    expect(telemetry.get('fresh')).toBeUndefined()
    expect(telemetry.get('kept')).toBeDefined()
  })
})

type Listener = (...args: never[]) => unknown

const installOn = (over: Partial<Resolved> = {}) => {
  const telemetry = new MemorySkillTelemetry()
  const listeners = new Map<string, Listener>()
  const ctx = {
    on: (event: string, handler: Listener) => { listeners.set(event, handler) },
  } as unknown as Context
  installUsageTelemetry(ctx, { telemetry, configSource: configSource(over) })
  const toolsResult = listeners.get('tools/result')! as (exec: unknown, result: unknown) => void
  const sessionEvent = listeners.get('session/event')! as (session: unknown, event: unknown) => void
  return { telemetry, toolsResult, sessionEvent }
}

describe('installUsageTelemetry', () => {
  it('bumps on a successful stock skill tool result', async () => {
    const { telemetry, toolsResult } = installOn()
    toolsResult({ name: 'skill', arguments: { name: 'agent-reach' } }, { isError: false })
    await Promise.resolve()
    expect(telemetry.get('agent-reach')?.useCount).toBe(1)
  })

  it('ignores failed calls, other tools, and malformed arguments', async () => {
    const { telemetry, toolsResult } = installOn()
    toolsResult({ name: 'skill', arguments: { name: 'x' } }, { isError: true })
    toolsResult({ name: 'bash', arguments: { name: 'x' } }, { isError: false })
    toolsResult({ name: 'skill', arguments: 'not-an-object' }, { isError: false })
    toolsResult({ name: 'skill', arguments: { name: 42 } }, { isError: false })
    await Promise.resolve()
    expect(telemetry.list().size).toBe(0)
  })

  it('bumps on a user /name skill-invocation message', async () => {
    const { telemetry, sessionEvent } = installOn()
    sessionEvent({}, { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'grill-me' } } })
    await Promise.resolve()
    expect(telemetry.get('grill-me')?.useCount).toBe(1)
  })

  it('ignores other session events and other message sources', async () => {
    const { telemetry, sessionEvent } = installOn()
    sessionEvent({}, { type: 'turn/end', data: {} })
    sessionEvent({}, { type: 'user/message', data: { source: { kind: 'user' } } })
    sessionEvent({}, { type: 'user/message', data: {} })
    await Promise.resolve()
    expect(telemetry.list().size).toBe(0)
  })

  it('a stale row reactivates on real use', async () => {
    const { telemetry, toolsResult } = installOn()
    await telemetry.update('sleeper', () => usage({ state: 'stale', useCount: 5 }))
    toolsResult({ name: 'skill', arguments: { name: 'sleeper' } }, { isError: false })
    await Promise.resolve()
    expect(telemetry.get('sleeper')).toMatchObject({ state: 'active', useCount: 6 })
  })

  it('curatorEnabled: false leaves both seams inert', async () => {
    const { telemetry, toolsResult, sessionEvent } = installOn({ curatorEnabled: false })
    toolsResult({ name: 'skill', arguments: { name: 'x' } }, { isError: false })
    sessionEvent({}, { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'y' } } })
    await Promise.resolve()
    expect(telemetry.list().size).toBe(0)
  })
})
