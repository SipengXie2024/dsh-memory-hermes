import { describe, expect, it } from 'vitest'
import { approvalReason, decidePreExecute } from '../src/policy.js'

describe('approvalReason', () => {
  it('summarizes an add with its file and content', () => {
    expect(approvalReason({ action: 'add', file: 'user', content: 'speaks Chinese' }))
      .toBe('memory add in USER.md: "speaks Chinese"')
  })

  it('summarizes a remove with its target', () => {
    expect(approvalReason({ action: 'remove', file: 'memory', target: 'old fact' }))
      .toBe('memory remove in MEMORY.md: "old fact"')
  })

  it('truncates very long content', () => {
    const reason = approvalReason({ action: 'add', file: 'memory', content: 'x'.repeat(300) })
    expect([...reason].length).toBeLessThan(160)
    expect(reason).toContain('...')
  })

  it('falls back to a generic reason for unparseable arguments', () => {
    expect(approvalReason({ action: 'archive' })).toBe('memory write')
    expect(approvalReason(undefined)).toBe('memory write')
  })
})

describe('decidePreExecute', () => {
  const exec = { name: 'memory', arguments: { action: 'add', file: 'memory', content: 'fact' } }

  it('asks when the gate is on and the call is memory', () => {
    expect(decidePreExecute(exec, true)).toEqual({ kind: 'ask', reason: 'memory add in MEMORY.md: "fact"' })
  })

  it('delegates when the gate is off', () => {
    expect(decidePreExecute(exec, false)).toBeUndefined()
  })

  it('delegates for other tools even when the gate is on', () => {
    expect(decidePreExecute({ name: 'shell', arguments: {} }, true)).toBeUndefined()
  })
})
