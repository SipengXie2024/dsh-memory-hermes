import { describe, expect, it } from 'vitest'
import { LIST_CALL, RPC_CHANNEL, cleanErrorMessage, formatBytes, formatDuration, formatUsage, mutateCall, summarizeRun, unwrapRpc } from '../src/client/logic.js'

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

describe('formatDuration', () => {
  it('formats sub-second, seconds, minutes, and hours', () => {
    expect(formatDuration(469)).toBe('469ms')
    expect(formatDuration(46_954)).toBe('46秒')
    expect(formatDuration(145_608)).toBe('2分25秒')
    expect(formatDuration(3_600_000)).toBe('1小时')
    expect(formatDuration(3_780_000)).toBe('1小时3分')
  })
})

describe('cleanErrorMessage', () => {
  it('unwraps nested JSON error shells to the innermost message', () => {
    const raw = 'review call did not finish cleanly (error): {"message":"400 {\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"tool_call_id is not found\\"},\\"type\\":\\"error\\"}","code":"INVALID_REQUEST"}'
    expect(cleanErrorMessage(raw)).toBe('tool_call_id is not found')
  })

  it('strips the review-failure prefix and keeps plain messages', () => {
    expect(cleanErrorMessage('review call did not finish cleanly (aborted)')).toBe('')
    expect(cleanErrorMessage('boom')).toBe('boom')
  })

  it('caps long messages', () => {
    expect([...cleanErrorMessage('x'.repeat(500))].length).toBeLessThanOrEqual(143)
  })
})

describe('summarizeRun', () => {
  it('says nothing-to-save when all counters are zero', () => {
    expect(summarizeRun({ applied: 0, rejected: 0, malformed: 0, foreign: 0 })).toBe('没有新内容可存')
  })

  it('summarizes memory writes in plain language', () => {
    expect(summarizeRun({ applied: 3, rejected: 1, malformed: 0, foreign: 0 })).toBe('存了 3 条记忆 · 1 条被拒')
  })

  it('summarizes skill actions with names', () => {
    expect(summarizeRun({
      applied: 0,
      rejected: 0,
      malformed: 0,
      foreign: 0,
      skillActions: { created: 1, updated: 0, patched: 2, deleted: 0, filesWritten: 1, filesRemoved: 0, skills: ['dsh-plugin-workflow'] },
    })).toBe('skill:新建 1/补丁 2/支持文件 1(dsh-plugin-workflow)')
  })

  it('summarizes topic writes with names', () => {
    expect(summarizeRun({ applied: 1, rejected: 0, malformed: 0, foreign: 0, topics: ['deploy-topology'] }))
      .toBe('存了 1 条记忆 · 写了 1 个主题文件(deploy-topology)')
  })
})

describe('formatBytes', () => {
  it('renders bytes below a kB raw and larger sizes in kB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(3993)).toBe('3.9 kB')
  })
})
