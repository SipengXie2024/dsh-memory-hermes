import { describe, expect, it } from 'vitest'
import { LIST_CALL, RPC_CHANNEL, formatUsage, mutateCall, unwrapRpc } from '../src/client/logic.js'

describe('call shapes', () => {
  it('list targets the gateway namespace with exactly-empty args', () => {
    expect(LIST_CALL).toEqual({
      channel: '/api',
      endpoint: 'memoryHermes/list',
      payload: { args: {} },
    })
  })

  it('mutate wires the op under the host parameter name', () => {
    const op = { action: 'add', file: 'memory', content: 'a fact' }
    expect(mutateCall(op)).toEqual({
      channel: RPC_CHANNEL,
      endpoint: 'memoryHermes/mutate',
      payload: { args: { op } },
    })
  })
})

describe('unwrapRpc', () => {
  it('returns the value branch', () => {
    expect(unwrapRpc<{ n: number }>({ ok: true, value: { n: 1 } })).toEqual({ n: 1 })
  })

  it('throws the error message on the failure branch', () => {
    expect(() => unwrapRpc({ ok: false, error: { message: 'boom', code: 'internal' } }))
      .toThrow('boom')
  })

  it('falls back to a generic message when the error carries none', () => {
    expect(() => unwrapRpc({ ok: false, error: { message: '' } })).toThrow('RPC call failed')
  })

  it('rejects malformed results', () => {
    expect(() => unwrapRpc(undefined)).toThrow('malformed RPC result')
    expect(() => unwrapRpc('nope')).toThrow('malformed RPC result')
    expect(() => unwrapRpc({})).toThrow('malformed RPC result')
  })
})

describe('formatUsage', () => {
  it('renders percent and char counts', () => {
    const dash = String.fromCodePoint(0x2014)
    expect(formatUsage(91, 220, 41)).toBe(`41% full ${dash} 91/220 chars`)
  })
})
