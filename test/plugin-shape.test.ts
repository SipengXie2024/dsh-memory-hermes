import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('plugin shape', () => {
  it('exports the cordis plugin surface', () => {
    expect(plugin.name).toBe('memory-hermes')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof plugin.apply).toBe('function')
    expect(typeof plugin.Config).toBe('function')
  })

  it('Config fills Hermes defaults', () => {
    const resolved = new plugin.Config({})
    expect(resolved).toEqual({
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      securityScan: true,
      approval: false,
    })
  })

  it('Config rejects sub-minimum limits', () => {
    expect(() => new plugin.Config({ memoryCharLimit: 10 })).toThrow()
  })

  it('Config accepts a full override', () => {
    const resolved = new plugin.Config({
      memoryCharLimit: 4000,
      userCharLimit: 2000,
      securityScan: false,
      approval: true,
    })
    expect(resolved.memoryCharLimit).toBe(4000)
    expect(resolved.approval).toBe(true)
  })
})
