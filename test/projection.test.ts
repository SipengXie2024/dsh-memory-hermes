import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { memoryActivityProjection, memoryActivitySchema } from '../src/projection.js'

const toolCall = (callId: string, args: unknown, time = 1000): SessionEvent => ({
  type: 'tool/call',
  seq: 1,
  time,
  data: { turn: 1, step: 1, callId, name: 'memory', arguments: JSON.stringify(args) },
}) as unknown as SessionEvent

const toolResult = (callId: string, failed = false): SessionEvent => ({
  type: 'tool/result',
  seq: 2,
  time: 1001,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'user', content: [{ type: 'tool-result', callId, content: [], isError: failed }] },
    ...failed ? { error: { name: 'HarnessError', code: 'MEMORY_OVERFLOW' } } : {},
  },
}) as unknown as SessionEvent

describe('memoryActivityProjection', () => {
  it('counts calls and settles them by callId', () => {
    let state = memoryActivityProjection.init()
    state = memoryActivityProjection.apply(state, toolCall('c1', { action: 'add', file: 'memory' }))
    expect(state.calls).toBe(1)
    expect(state.succeeded).toBe(0) // in flight
    state = memoryActivityProjection.apply(state, toolResult('c1'))
    expect(state).toMatchObject({ calls: 1, succeeded: 1, failed: 0, lastAction: 'add', lastFile: 'memory', lastAt: 1000 })
    expect(state.pending).toEqual({})
  })

  it('counts failed results separately', () => {
    let state = memoryActivityProjection.init()
    state = memoryActivityProjection.apply(state, toolCall('c1', { action: 'remove', file: 'user' }))
    state = memoryActivityProjection.apply(state, toolResult('c1', true))
    expect(state).toMatchObject({ calls: 1, succeeded: 0, failed: 1, lastAction: 'remove', lastFile: 'user' })
  })

  it('returns the same state reference for unrelated events', () => {
    const state = memoryActivityProjection.init()
    const unrelated = { type: 'turn/end', seq: 9, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent
    expect(memoryActivityProjection.apply(state, unrelated)).toBe(state)
    const otherTool = {
      type: 'tool/call', seq: 3, time: 2,
      data: { turn: 1, step: 1, callId: 'x', name: 'shell', arguments: '{}' },
    } as unknown as SessionEvent
    expect(memoryActivityProjection.apply(state, otherTool)).toBe(state)
  })

  it('ignores results for unknown callIds', () => {
    const state = memoryActivityProjection.init()
    expect(memoryActivityProjection.apply(state, toolResult('ghost'))).toBe(state)
  })

  it('tolerates unparseable call arguments (the call still counts)', () => {
    let state = memoryActivityProjection.init()
    const broken = {
      type: 'tool/call', seq: 1, time: 5,
      data: { turn: 1, step: 1, callId: 'c9', name: 'memory', arguments: '{nope' },
    } as unknown as SessionEvent
    state = memoryActivityProjection.apply(state, broken)
    expect(state.calls).toBe(1)
    state = memoryActivityProjection.apply(state, toolResult('c9'))
    expect(state.succeeded).toBe(1)
    expect(memoryActivityProjection.view(state)).toEqual({ calls: 1, succeeded: 1, failed: 0, lastAt: 5 })
  })

  it('view drops the in-flight map and validates against the wire schema', () => {
    let state = memoryActivityProjection.init()
    state = memoryActivityProjection.apply(state, toolCall('c1', { action: 'add', file: 'memory' }))
    state = memoryActivityProjection.apply(state, toolResult('c1'))
    const value = memoryActivityProjection.view(state)
    expect(value).not.toHaveProperty('pending')
    expect(memoryActivitySchema.parse(value)).toEqual(value)
  })

  it('view of the initial state is the zero summary', () => {
    expect(memoryActivityProjection.view(memoryActivityProjection.init())).toEqual({ calls: 0, succeeded: 0, failed: 0 })
  })
})
